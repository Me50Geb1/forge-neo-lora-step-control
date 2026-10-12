# Forge Neo LoRA Step Control

**Version: V1**

Minimal LoRA sampling-step control extension for **Forge Neo 2.30**.

This extension adds sampling-step scheduling to normal LoRA tags without implementing its own block-weight system.

## Supported syntax

```text
<lora:MyLora:1:start=10>
<lora:MyLora:1:stop=10>
<lora:MyLora:1:step=5-10>
```

- `start=10` — LoRA is disabled before sampling step 10, then enabled.
- `stop=10` — LoRA is enabled for steps 0 through 9, then disabled from step 10.
- `step=5-10` — LoRA is enabled for steps 5 through 9 (`[5, 10)`).

`step=A-B` is equivalent to `start=A` + `stop=B` and overrides separately supplied `start=` / `stop=` values.

## Compatibility

V1 has been tested with:

- Forge Neo 2.30
- Python 3.13
- Anima
- `0x7flumic/lora-block-weight-neo`
- Forge Neo on-the-fly / OnlineLoRAPatch LoRA loading

The implementation is architecture-agnostic at the scheduling layer because it gates the actual runtime LoRA wrappers rather than depending on model-specific block names.

## Using with lora-block-weight-neo

Block Weight and Step Control can be used together.

```text
<lora:MyLora:start=10:1:lbw=FACE>
<lora:MyLora:stop=10:1:lbw=0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1>
<lora:MyLora:step=5-15:0.8:lbw=STYLE>
```

`lbw=` is not parsed as block-weight logic by this extension. Block weighting remains the responsibility of `lora-block-weight-neo`.

When a scheduled LoRA is present, this extension temporarily enables Forge Neo's online LoRA path for that generation. After LoRA activation it finds the actual runtime wrapper class used by Forge Neo and gates each matching wrapper by sampling step.

This preserves the block-specific strength already applied by `lora-block-weight-neo`: an inactive step temporarily uses zero strength, while an active step uses the existing LBW-adjusted strength.

## In-prompt Step Control UI

When `lora-block-weight-neo` is installed, this extension adds a **Step Control** section to its LoRA popover.

Available controls:

- **Always / Off** — removes `start=`, `stop=` and `step=`
- **Start** — writes `start=N`
- **Stop** — writes `stop=N`
- **Step range** — writes `step=A-B`
- **Start + Stop** — sets both boundaries

The UI preserves scheduling parameters when LoRA Weight, LBW presets, or block sliders rebuild the LoRA tag.

## Installation

1. Remove or disable the old `sd-webui-lora-block-weight-forgeneo-anima` if it is still installed for step scheduling.
2. Keep `lora-block-weight-neo` enabled if you use block weighting.
3. Clone or extract this repository into:

```text
sd-webui-forge-neo/extensions/forge-neo-lora-step-control/
```

4. Restart Forge Neo completely.

No additional Python packages are required.

## Notes

- `stop=N` is exclusive: `stop=10` means the LoRA is off from sampling step 10 onward.
- `step=5-10` is therefore active at steps 5, 6, 7, 8 and 9.
- Normal LoRAs without `start=`, `stop=` or `step=` are not scheduled.
- Duplicate use of the exact same LoRA file with different schedules in one prompt is not supported because Forge identifies online wrappers by LoRA filename.
- V1 is the first locally tested working release, including simultaneous use with `lora-block-weight-neo` block values.
