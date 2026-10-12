/**
 * Forge Neo LoRA Step Control - compatibility UI for lora-block-weight-neo.
 *
 * Important compatibility rule:
 * lora-block-weight-neo treats unknown parameters at position >= 2 as an LBW
 * value. Therefore this extension keeps exactly one schedule token immediately
 * after the LoRA name while the LBW popover is opened:
 *   <lora:name:start=10:1:lbw=FACE>
 *   <lora:name:stop=10:1:lbw=FACE>
 *   <lora:name:step=5-10:1:lbw=FACE>
 *
 * When LBW rebuilds the tag it drops unknown parameters. Step Control restores
 * the schedule immediately after that rewrite and sends one synthetic click
 * inside the repaired tag so LBW refreshes its private start/end indices.
 */
(function () {
    "use strict";

    const PANEL_ID = "lsc-step-panel";
    const LBW_POPOVER_ID = "lbw-inprompt-popover";
    const SCHEDULE_KEYS = new Set(["start", "stop", "step"]);

    let activeTextarea = null;
    let activeTagHint = null;
    let pendingSchedule = null;
    let internalWrite = false;
    let sessionOpen = false;
    let resyncingLbw = false;

    function notifyInput(textarea) {
        if (!textarea) return;
        if (typeof updateInput === "function") updateInput(textarea);
        else textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function isPromptTextarea(elem) {
        if (!elem || elem.tagName !== "TEXTAREA") return false;
        if (elem.closest("#txt2img_prompt, #img2img_prompt, #txt2img_neg_prompt, #img2img_neg_prompt, .prompt")) return true;
        return typeof elem.value === "string" && elem.value.includes("<lora:");
    }

    function parseLoraTag(tagStr, startIdx) {
        if (!tagStr || !tagStr.toLowerCase().startsWith("<lora:") || !tagStr.endsWith(">")) return null;
        const parts = tagStr.slice(6, -1).split(":");
        const name = (parts.shift() || "").trim();
        if (!name) return null;

        const params = parts.map(raw => {
            const text = String(raw).trim();
            const eq = text.indexOf("=");
            if (eq > 0) {
                return { raw: text, key: text.slice(0, eq).trim().toLowerCase(), value: text.slice(eq + 1).trim(), named: true };
            }
            return { raw: text, key: null, value: text, named: false };
        });

        let start = null, stop = null, step = null;
        for (const p of params) {
            if (!p.named) continue;
            if (p.key === "start") start = p.value;
            else if (p.key === "stop") stop = p.value;
            else if (p.key === "step") step = p.value;
        }
        return { fullTag: tagStr, startIdx, endIdx: startIdx + tagStr.length, name, params, schedule: { start, stop, step } };
    }

    function findLoraAtPosition(textarea, pos) {
        if (!textarea || typeof textarea.value !== "string") return null;
        const text = textarea.value;
        const safePos = Math.max(0, Math.min(Number.isFinite(pos) ? pos : (textarea.selectionStart || 0), text.length));
        const openIdx = text.lastIndexOf("<lora:", safePos);
        if (openIdx === -1) return null;
        const closeIdx = text.indexOf(">", openIdx);
        if (closeIdx === -1 || safePos > closeIdx + 1) return null;
        const nested = text.indexOf("<", openIdx + 1);
        if (nested !== -1 && nested < closeIdx) return null;
        return parseLoraTag(text.substring(openIdx, closeIdx + 1), openIdx);
    }

    function findTagByHint(textarea) {
        if (!textarea) return null;
        const direct = findLoraAtPosition(textarea, textarea.selectionStart || 0);
        if (direct && (!activeTagHint || direct.name === activeTagHint.name)) return direct;
        if (!activeTagHint) return direct;

        const text = textarea.value;
        const re = /<lora:[^>]+>/gi;
        let best = null, bestDistance = Infinity, m;
        while ((m = re.exec(text)) !== null) {
            const parsed = parseLoraTag(m[0], m.index);
            if (!parsed || parsed.name !== activeTagHint.name) continue;
            const d = Math.abs(parsed.startIdx - activeTagHint.startIdx);
            if (d < bestDistance) { best = parsed; bestDistance = d; }
        }
        return best;
    }

    function normalizedIntString(value) {
        const text = String(value ?? "").trim();
        if (!/^\d+$/.test(text)) return null;
        const n = Number(text);
        if (!Number.isSafeInteger(n) || n < 0) return null;
        return String(n);
    }

    function parseStepRange(value) {
        const m = String(value ?? "").trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) return null;
        const a = Number(m[1]), b = Number(m[2]);
        if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a) return null;
        return { start: String(a), stop: String(b) };
    }

    function scheduleFromTag(tag) {
        if (!tag) return { mode: "none", start: "", stop: "" };
        if (tag.schedule.step != null) {
            const r = parseStepRange(tag.schedule.step);
            return r ? { mode: "step", start: r.start, stop: r.stop } : { mode: "none", start: "", stop: "" };
        }
        if (tag.schedule.start != null && tag.schedule.stop != null) {
            return { mode: "step", start: tag.schedule.start, stop: tag.schedule.stop };
        }
        if (tag.schedule.start != null) return { mode: "start", start: tag.schedule.start, stop: "" };
        if (tag.schedule.stop != null) return { mode: "stop", start: "", stop: tag.schedule.stop };
        return { mode: "none", start: "", stop: "" };
    }

    function scheduleToken(schedule) {
        if (!schedule || schedule.mode === "none") return null;
        if (schedule.mode === "start") return `start=${schedule.start}`;
        if (schedule.mode === "stop") return `stop=${schedule.stop}`;
        return `step=${schedule.start}-${schedule.stop}`;
    }

    function rewriteCanonical(tag, schedule, setSelection) {
        if (!activeTextarea || !tag) return false;
        const preserved = [];
        for (const p of tag.params) {
            if (p.named && SCHEDULE_KEYS.has(p.key)) continue;
            if (p.named && p.key === "lbw" && /^(start|stop|step)=/i.test(p.value)) continue;
            if (p.raw) preserved.push(p.raw);
        }
        const token = scheduleToken(schedule);
        const all = token ? [token, ...preserved] : preserved;
        const newTag = `<lora:${tag.name}${all.length ? ":" + all.join(":") : ""}>`;

        internalWrite = true;
        const value = activeTextarea.value;
        activeTextarea.value = value.substring(0, tag.startIdx) + newTag + value.substring(tag.endIdx);
        activeTagHint = { name: tag.name, startIdx: tag.startIdx, endIdx: tag.startIdx + newTag.length };
        if (setSelection) {
            const caret = Math.min(tag.startIdx + newTag.length - 1, activeTextarea.value.length);
            activeTextarea.setSelectionRange(caret, caret);
        }
        notifyInput(activeTextarea);
        internalWrite = false;
        return true;
    }

    function controlElements(panel) {
        return {
            mode: panel.querySelector("#lsc-mode"), start: panel.querySelector("#lsc-start"), stop: panel.querySelector("#lsc-stop"),
            startWrap: panel.querySelector("#lsc-start-wrap"), stopWrap: panel.querySelector("#lsc-stop-wrap"),
            summary: panel.querySelector("#lsc-summary"), error: panel.querySelector("#lsc-error")
        };
    }

    function renderMode(panel) {
        const e = controlElements(panel), mode = e.mode.value;
        e.startWrap.style.display = ["start", "step"].includes(mode) ? "flex" : "none";
        e.stopWrap.style.display = ["stop", "step"].includes(mode) ? "flex" : "none";
        if (mode === "none") e.summary.textContent = "Always active";
        else if (mode === "start") e.summary.textContent = `Enable from step ${e.start.value || "…"}`;
        else if (mode === "stop") e.summary.textContent = `Disable at step ${e.stop.value || "…"}`;
        else e.summary.textContent = `Active only in [${e.start.value || "…"}, ${e.stop.value || "…"})`;
    }

    function validatePanel(panel) {
        const e = controlElements(panel), mode = e.mode.value;
        e.error.textContent = "";
        if (mode === "none") return { mode: "none", start: "", stop: "" };
        let start = "", stop = "";
        if (["start", "step"].includes(mode)) {
            start = normalizedIntString(e.start.value);
            if (start === null) { e.error.textContent = "Start must be a non-negative integer."; return null; }
        }
        if (["stop", "step"].includes(mode)) {
            stop = normalizedIntString(e.stop.value);
            if (stop === null) { e.error.textContent = "Stop must be a non-negative integer."; return null; }
        }
        if (mode === "step" && Number(stop) < Number(start)) {
            e.error.textContent = "Stop must be greater than or equal to Start."; return null;
        }
        return { mode, start, stop };
    }

    function syncPanel(panel) {
        if (!panel) return;
        const s = pendingSchedule || scheduleFromTag(findTagByHint(activeTextarea));
        panel.style.display = "block";
        const e = controlElements(panel);
        e.mode.value = s.mode;
        e.start.value = s.start || "";
        e.stop.value = s.stop || "";
        e.error.textContent = "";
        renderMode(panel);
    }

    function commitScheduleNow(schedule) {
        if (!activeTextarea || !activeTagHint || !schedule) return false;
        const tag = findTagByHint(activeTextarea);
        if (!tag) return false;

        pendingSchedule = schedule;
        if (!rewriteCanonical(tag, schedule, false)) return false;

        const repaired = findTagByHint(activeTextarea);
        if (!repaired) return true;
        activeTagHint = { name: repaired.name, startIdx: repaired.startIdx, endIdx: repaired.endIdx };
        const caret = Math.max(repaired.startIdx + 1, repaired.endIdx - 1);
        activeTextarea.setSelectionRange(caret, caret);
        resyncingLbw = true;
        try {
            activeTextarea.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        } finally {
            resyncingLbw = false;
        }
        return true;
    }

    function buildPanel() {
        const panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.className = "lsc-step-panel";
        panel.innerHTML = `
            <div class="lsc-header-row"><span class="lsc-heading">Step Control</span><span id="lsc-summary" class="lsc-summary">Always active</span></div>
            <div class="lsc-controls-row">
                <label class="lsc-field lsc-mode-field"><span>Mode</span><select id="lsc-mode">
                    <option value="none">Always / Off</option><option value="start">Start</option><option value="stop">Stop</option><option value="step">Step range</option>
                </select></label>
                <label id="lsc-start-wrap" class="lsc-field"><span>Start</span><input id="lsc-start" type="number" min="0" step="1" inputmode="numeric" placeholder="5"></label>
                <label id="lsc-stop-wrap" class="lsc-field"><span>Stop</span><input id="lsc-stop" type="number" min="0" step="1" inputmode="numeric" placeholder="10"></label>
                <button id="lsc-clear" type="button" class="lsc-clear-btn">Clear</button>
            </div>
            <div class="lsc-help">Step settings are written to the prompt immediately and preserved while LBW Weight, presets, and block sliders are edited. <code>step=5-10</code> is active at steps 5–9.</div>
            <div id="lsc-error" class="lsc-error"></div>`;

        const e = controlElements(panel);
        const updatePending = () => {
            renderMode(panel);
            const s = validatePanel(panel);
            if (s) commitScheduleNow(s);
        };
        e.mode.addEventListener("change", updatePending);
        e.start.addEventListener("input", updatePending);
        e.stop.addEventListener("input", updatePending);
        panel.querySelector("#lsc-clear").addEventListener("click", () => {
            e.mode.value = "none"; e.start.value = ""; e.stop.value = "";
            renderMode(panel);
            commitScheduleNow({ mode: "none", start: "", stop: "" });
        });
        return panel;
    }

    function ensurePanel() {
        const lbw = document.getElementById(LBW_POPOVER_ID);
        if (!lbw) return null;
        let panel = lbw.querySelector(`#${PANEL_ID}`);
        if (panel) return panel;
        panel = buildPanel();
        const body = lbw.querySelector(".lbw-popover-body") || lbw;
        const blocks = body.querySelector(".lbw-blocks-section");
        if (blocks) body.insertBefore(panel, blocks); else body.appendChild(panel);
        return panel;
    }

    function beginSession(textarea) {
        if (resyncingLbw) return;
        activeTextarea = textarea;
        let tag = findLoraAtPosition(textarea, textarea.selectionStart || 0);
        if (!tag) return;
        activeTagHint = { name: tag.name, startIdx: tag.startIdx, endIdx: tag.endIdx };
        pendingSchedule = scheduleFromTag(tag);

        rewriteCanonical(tag, pendingSchedule, true);
        tag = findLoraAtPosition(textarea, textarea.selectionStart || 0) || tag;
        activeTagHint = { name: tag.name, startIdx: tag.startIdx, endIdx: tag.endIdx };
        sessionOpen = true;

        queueMicrotask(() => {
            const panel = ensurePanel();
            if (panel) syncPanel(panel);
            else requestAnimationFrame(() => { const p = ensurePanel(); if (p) syncPanel(p); });
        });
    }

    function endSession() {
        if (!sessionOpen || !activeTextarea || !activeTagHint) return;
        const tag = findTagByHint(activeTextarea);
        if (tag) rewriteCanonical(tag, pendingSchedule || { mode: "none", start: "", stop: "" }, false);
        sessionOpen = false;
        pendingSchedule = null;
    }

    function init() {
        document.addEventListener("click", e => {
            if (isPromptTextarea(e.target)) beginSession(e.target);
        }, true);

        document.addEventListener("mousedown", e => {
            if (!sessionOpen) return;
            const pop = document.getElementById(LBW_POPOVER_ID);
            if (pop && pop.contains(e.target)) return;
            if (e.target === activeTextarea) return;
            endSession();
        }, true);

        document.addEventListener("click", e => {
            if (sessionOpen && e.target && e.target.id === "lbw-popover-close") endSession();
        }, true);

        document.addEventListener("keydown", e => {
            if (sessionOpen && e.key === "Escape") endSession();
        }, true);

        document.addEventListener("input", e => {
            if (internalWrite || !sessionOpen || e.target !== activeTextarea || resyncingLbw) return;
            const tag = findTagByHint(activeTextarea);
            if (!tag) return;
            activeTagHint = { name: tag.name, startIdx: tag.startIdx, endIdx: tag.endIdx };

            const desired = pendingSchedule || scheduleFromTag(tag);
            const actual = scheduleFromTag(tag);
            const desiredToken = scheduleToken(desired);
            const actualToken = scheduleToken(actual);
            if (desiredToken === actualToken) return;

            queueMicrotask(() => {
                if (!sessionOpen || !activeTextarea || resyncingLbw) return;
                const latest = findTagByHint(activeTextarea);
                if (!latest) return;

                rewriteCanonical(latest, desired, false);
                const repaired = findTagByHint(activeTextarea);
                if (!repaired) return;
                activeTagHint = { name: repaired.name, startIdx: repaired.startIdx, endIdx: repaired.endIdx };

                const caret = Math.max(repaired.startIdx + 1, repaired.endIdx - 1);
                activeTextarea.setSelectionRange(caret, caret);
                resyncingLbw = true;
                try {
                    activeTextarea.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                } finally {
                    resyncingLbw = false;
                }
            });
        }, true);
    }

    if (typeof onUiLoaded === "function") onUiLoaded(init);
    else document.addEventListener("DOMContentLoaded", init);
})();
