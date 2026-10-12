"""Forge Neo LoRA Step Control.

Adds start/stop/step named parameters to normal Forge Neo LoRA tags without
implementing block-weight logic.

Examples:
    <lora:MyLora:1:start=10>
    <lora:MyLora:1:stop=10>
    <lora:MyLora:1:step=5-10>

The extension uses Forge Neo's online LoRA wrappers and CFG denoiser callback.
It intentionally does not parse or modify lbw=.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Optional

from backend.args import dynamic_args
from modules import scripts, shared
from modules.processing import StableDiffusionProcessing
from modules.script_callbacks import CFGDenoiserParams, on_cfg_denoiser

logger = logging.getLogger("lora_step_control")

_PATCHED_CLASSES = {}  # cls -> original __call__

def _ensure_wrapper_class_patched(wrapper_cls):
    if wrapper_cls in _PATCHED_CLASSES:
        return
    original_call = wrapper_cls.__call__
    def _patched_call(self, weight):
        wrapper_name = getattr(self, "name", None)
        schedule = LoRAStepControl._find_schedule(wrapper_name)
        step = LoRAStepControl.current_sampling_step
        if LoRAStepControl.mapping and wrapper_name:
            name_s = str(wrapper_name)
            if name_s not in LoRAStepControl.debug_seen_wrappers and len(LoRAStepControl.debug_seen_wrappers) < 20:
                LoRAStepControl.debug_seen_wrappers.add(name_s)
        if schedule is not None and step is not None:
            active = schedule.active_at(step)
            key = (str(wrapper_name), int(step), bool(active))
            if key not in LoRAStepControl.debug_seen_step_states:
                LoRAStepControl.debug_seen_step_states.add(key)
        if schedule is None or step is None or schedule.active_at(step):
            return original_call(self, weight)

        patch = getattr(self, "patch", None)
        if not isinstance(patch, list) or not patch:
            return original_call(self, weight)
        first = patch[0]
        if not isinstance(first, list) or not first:
            return original_call(self, weight)

        original_strength = first[0]
        first[0] = original_strength * 0
        try:
            return original_call(self, weight)
        finally:
            first[0] = original_strength
    wrapper_cls.__call__ = _patched_call
    _PATCHED_CLASSES[wrapper_cls] = original_call

# Only used early in before_process to decide whether this generation needs
# Forge's on-the-fly LoRA wrappers. Actual schedule parsing uses Forge's parsed
# ExtraNetworkParams in after_extra_networks_activate().
_SCHEDULE_TAG_RE = re.compile(
    r"<lora:[^>]+:(?:[^>]*:)?(?:start|stop|step)\s*=",
    flags=re.IGNORECASE,
)


class StepSchedule:
    """Half-open sampling-step interval [start, stop).

    Kept as a plain class instead of a dataclass because Forge Neo loads
    extension scripts with importlib without necessarily registering the
    temporary module in sys.modules first. Python 3.13 dataclasses inspect
    sys.modules during decoration and can fail in that loading path.
    """

    __slots__ = ("start", "stop")

    def __init__(self, start: Optional[int] = None, stop: Optional[int] = None):
        self.start = start
        self.stop = stop

    def active_at(self, sampling_step: int) -> bool:
        if self.start is not None and sampling_step < self.start:
            return False
        if self.stop is not None and sampling_step >= self.stop:
            return False
        return True


def _parse_nonnegative_int(value: object, key: str, lora_name: str) -> Optional[int]:
    if value is None:
        return None
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        logger.error('[LoRA Step] Invalid %s for "%s": %r', key, lora_name, value)
        return None
    if parsed < 0:
        logger.error('[LoRA Step] %s must be >= 0 for "%s": %r', key, lora_name, value)
        return None
    return parsed


def _schedule_from_named(named: dict, lora_name: str) -> Optional[StepSchedule]:
    """Parse the three supported named parameters.

    Compatibility with sd-webui-lora-block-weight-forgeneo-anima:
    step=A-B overrides separately supplied start=/stop= and means [A, B).
    """
    raw_step = named.get("step")
    if raw_step is not None:
        match = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", str(raw_step))
        if not match:
            logger.error('[LoRA Step] Invalid step= range for "%s": %r', lora_name, raw_step)
            return None
        start = int(match.group(1))
        stop = int(match.group(2))
        if stop < start:
            logger.error('[LoRA Step] step= end must be >= start for "%s": %r', lora_name, raw_step)
            return None
        return StepSchedule(start=start, stop=stop)

    has_start = "start" in named
    has_stop = "stop" in named
    if not has_start and not has_stop:
        return None

    start = _parse_nonnegative_int(named.get("start"), "start", lora_name) if has_start else None
    stop = _parse_nonnegative_int(named.get("stop"), "stop", lora_name) if has_stop else None

    if has_start and start is None:
        return None
    if has_stop and stop is None:
        return None
    if start is not None and stop is not None and stop < start:
        logger.error('[LoRA Step] stop must be >= start for "%s": start=%s stop=%s', lora_name, start, stop)
        return None

    return StepSchedule(start=start, stop=stop)


def _prompt_has_schedule(prompt: object) -> bool:
    if isinstance(prompt, str):
        return bool(_SCHEDULE_TAG_RE.search(prompt))
    if isinstance(prompt, (list, tuple)):
        return any(isinstance(x, str) and _SCHEDULE_TAG_RE.search(x) for x in prompt)
    return False


class LoRAStepControl(scripts.Script):
    # normalized LoRA filename -> schedule
    mapping: dict[str, StepSchedule] = {}
    current_sampling_step: Optional[int] = None
    debug_seen_wrappers: set[str] = set()
    debug_seen_step_states: set[tuple[str, int, bool]] = set()

    def __init__(self):
        super().__init__()
        self._forced_online = False
        self._previous_online_lora = False

    def title(self):
        return "LoRA Step Control"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        return None

    def before_process(self, p: StableDiffusionProcessing, *args, **kwargs):
        type(self).mapping.clear()
        type(self).current_sampling_step = None
        type(self).debug_seen_wrappers.clear()
        type(self).debug_seen_step_states.clear()
        self._forced_online = False
        self._previous_online_lora = bool(dynamic_args.online_lora)

        prompts = getattr(p, "all_prompts", None)
        has_schedule = _prompt_has_schedule(getattr(p, "prompt", None)) or _prompt_has_schedule(prompts)
        if not has_schedule:
            return

        if not dynamic_args.online_lora:
            dynamic_args.online_lora = True
            self._forced_online = True
            logger.info("[LoRA Step] Temporarily enabled Forge on-the-fly LoRA patching")

    def after_extra_networks_activate(self, p: StableDiffusionProcessing, *args, **kwargs):
        extra_network_data = kwargs.get("extra_network_data")
        if not extra_network_data:
            return

        lora_params = extra_network_data.get("lora", [])
        if not lora_params:
            return

        try:
            import networks
        except ImportError:
            logger.exception("[LoRA Step] Forge LoRA module 'networks' is unavailable")
            return

        mapping: dict[str, StepSchedule] = {}

        for params in lora_params:
            positional = getattr(params, "positional", None) or []
            named = getattr(params, "named", None) or {}
            if not positional:
                continue

            alias = str(positional[0])
            schedule = _schedule_from_named(named, alias)
            if schedule is None:
                continue

            network_on_disk = networks.available_network_aliases.get(alias) or networks.available_networks.get(alias)
            if network_on_disk is None:
                try:
                    networks.update_available_networks_by_names([alias])
                    network_on_disk = networks.available_network_aliases.get(alias) or networks.available_networks.get(alias)
                except Exception:
                    network_on_disk = None

            filename = getattr(network_on_disk, "filename", None) if network_on_disk is not None else None
            if not filename:
                logger.error('[LoRA Step] Could not resolve LoRA alias "%s"', alias)
                continue

            mapping[os.path.normcase(os.path.abspath(filename))] = schedule

        type(self).mapping = mapping

        try:
            patchers = []
            for attr in ("forge_objects", "forge_objects_after_applying_lora"):
                obj = getattr(shared.sd_model, attr, None)
                unet = getattr(obj, "unet", None) if obj is not None else None
                if unet is not None and all(id(unet) != id(x) for x in patchers):
                    patchers.append(unet)
            for patcher in patchers:
                wrappers = getattr(patcher, "weight_wrapper_patches", {}) or {}
                for ws in wrappers.values():
                    for w in ws:
                        try:
                            _ensure_wrapper_class_patched(type(w))
                        except Exception:
                            logger.exception("[LoRA Step] failed to patch runtime wrapper class")
        except Exception:
            logger.exception('[LoRA Step] failed to inspect online wrappers')

    @classmethod
    def _find_schedule(cls, filename):
        if not filename:
            return None
        norm = os.path.normcase(os.path.abspath(str(filename)))
        schedule = cls.mapping.get(norm)
        if schedule is not None:
            return schedule

        base = os.path.normcase(os.path.basename(str(filename)))
        matches = [sched for path, sched in cls.mapping.items()
                   if os.path.normcase(os.path.basename(path)) == base]
        return matches[0] if len(matches) == 1 else None

    @classmethod
    def note_sampling_step(cls, params: CFGDenoiserParams):
        if not cls.mapping:
            cls.current_sampling_step = None
            return
        cls.current_sampling_step = int(params.sampling_step)

    def postprocess(self, p, processed, *args, **kwargs):
        type(self).current_sampling_step = None
        type(self).mapping.clear()
        if self._forced_online:
            dynamic_args.online_lora = self._previous_online_lora
            self._forced_online = False
            logger.info("[LoRA Step] Restored Forge on-the-fly LoRA setting")


on_cfg_denoiser(LoRAStepControl.note_sampling_step)
