'use strict';

// ---- pure time helpers (mirrors src/backend.js; kept local since renderer
// runs without nodeIntegration and can't require() the shared module) ----
function fmtTime(seconds, ms = true) {
  seconds = Math.max(0, seconds);
  const h = Math.floor(seconds / 3600);
  const rest = seconds - h * 3600;
  const m = Math.floor(rest / 60);
  const s = rest - m * 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  if (ms) return `${pad2(h)}:${pad2(m)}:${s.toFixed(3).padStart(6, '0')}`;
  return `${pad2(h)}:${pad2(m)}:${pad2(Math.floor(s))}`;
}

function parseTime(text) {
  const raw = (text || '').trim().replace(/,/g, '.');
  if (!raw) throw new Error('empty time');
  const parts = raw.split(':');
  if (parts.length > 3) throw new Error('not a time');
  let total = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isFinite(v)) throw new Error('not a time');
    total = total * 60 + v;
  }
  if (total < 0) throw new Error('negative time');
  return total;
}

// ---- dual-handle trim slider, with Shift/Ctrl precision drag ----
const FINE_SHIFT = 0.10;
const FINE_CTRL = 0.01;

// Module level rather than a method, because the audio waveform drag offers the
// same precision and has to read the modifiers exactly the same way.
function modifierFactor(evt) {
  if (evt.ctrlKey) return FINE_CTRL;
  if (evt.shiftKey) return FINE_SHIFT;
  return 1.0;
}

class TrimSlider {
  constructor(rootEl, startHandleEl, endHandleEl, fillEl) {
    this.root = rootEl;
    this.startHandle = startHandleEl;
    this.endHandle = endHandleEl;
    this.fill = fillEl;
    this.duration = 1;
    this.start = 0;
    this.end = 1;
    this.minSpan = 0.05;
    this.onChange = null;
    this.onDragStateChange = null;
    this._drag = null;

    this._bindHandle(this.startHandle, true);
    this._bindHandle(this.endHandle, false);
    window.addEventListener('resize', () => this._reposition());
  }

  setRange(duration, start, end) {
    this.duration = Math.max(duration, this.minSpan);
    this.start = this._clamp(start);
    this.end = this._clamp(end);
    this._enforceGap(false);
    this._reposition();
  }

  // Back to the constructor's values. Deliberately skips _enforceGap, which
  // would shove the handles minSpan apart; a fresh slider has them stacked at
  // the far left, and this has to look identical to that.
  reset() {
    this.duration = 1;
    this.start = 0;
    this.end = 0;
    this._reposition();
  }

  setStart(value, notify = true) {
    this.start = this._clamp(value);
    this._enforceGap(true);
    this._reposition();
    if (notify && this.onChange) this.onChange(this.start, this.end);
  }

  setEnd(value, notify = true) {
    this.end = this._clamp(value);
    this._enforceGap(false);
    this._reposition();
    if (notify && this.onChange) this.onChange(this.start, this.end);
  }

  _clamp(v) { return Math.min(Math.max(v, 0), this.duration); }

  _enforceGap(startMoved) {
    if (this.end - this.start >= this.minSpan) return;
    if (startMoved) {
      this.end = Math.min(this.duration, this.start + this.minSpan);
      this.start = Math.min(this.start, this.end - this.minSpan);
    } else {
      this.start = Math.max(0, this.end - this.minSpan);
      this.end = Math.max(this.end, this.start + this.minSpan);
    }
  }

  _usableWidth() {
    const w = this.root.clientWidth;
    const handleW = this.startHandle.offsetWidth || 16;
    return Math.max(1, w - 16 - handleW); // 16 = track's left+right inset
  }

  _valueToX(value) {
    const usable = this._usableWidth();
    const half = (this.startHandle.offsetWidth || 16) / 2;
    return 8 + half + (value / this.duration) * usable;
  }

  _xToValueDelta(deltaPixels) {
    const usable = this._usableWidth();
    return (deltaPixels / usable) * this.duration;
  }

  _reposition() {
    const startX = this._valueToX(this.start);
    const endX = this._valueToX(this.end);
    const half = (this.startHandle.offsetWidth || 16) / 2;
    this.startHandle.style.left = (startX - half) + 'px';
    this.endHandle.style.left = (endX - half) + 'px';
    this.fill.style.left = startX + 'px';
    this.fill.style.width = Math.max(0, endX - startX) + 'px';
  }

  _bindHandle(handle, isStart) {
    handle.addEventListener('pointerdown', (evt) => {
      handle.setPointerCapture(evt.pointerId);
      const factor = modifierFactor(evt);
      this._drag = {
        isStart, anchorX: evt.clientX,
        anchorValue: isStart ? this.start : this.end,
        factor,
      };
      if (this.onDragStateChange) this.onDragStateChange(factor);
      evt.preventDefault();
    });

    handle.addEventListener('pointermove', (evt) => {
      if (!this._drag || this._drag.isStart !== isStart) return;
      const factor = modifierFactor(evt);
      if (factor !== this._drag.factor) {
        // Modifier changed mid-drag: re-anchor so the new rate continues
        // from where the handle sits now, no jump.
        this._drag.anchorX = evt.clientX;
        this._drag.anchorValue = isStart ? this.start : this.end;
        this._drag.factor = factor;
        if (this.onDragStateChange) this.onDragStateChange(factor);
      }
      const delta = this._xToValueDelta(evt.clientX - this._drag.anchorX) * this._drag.factor;
      const newValue = this._drag.anchorValue + delta;
      if (isStart) this.setStart(newValue);
      else this.setEnd(newValue);
    });

    const endDrag = (evt) => {
      if (handle.hasPointerCapture(evt.pointerId)) handle.releasePointerCapture(evt.pointerId);
      this._drag = null;
      if (this.onDragStateChange) this.onDragStateChange(1.0);
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }
}

// ---- main controller ----
const el = (id) => document.getElementById(id);

// ---- popups ----
//
// Every modal registers here once, with what Escape and a click on its
// backdrop mean for it. modalOpen() and Escape both read this one list, so a
// new popup cannot be left out of either: the Crop Render Frame window was,
// and with it open Escape did nothing while Space, Delete and Ctrl+Z still
// reached the timeline behind it.
//
// `layer` is how high a popup sits over the others: the colour picker over
// Outline and Shadow over everything else, and a question over whatever asked
// it. Escape cancels the highest one open, and only that one.
const popups = [];

function bindPopup(modal, cancel, layer = 0) {
  popups.push({ modal, cancel, layer });
  // The press rather than the release: a drag that starts on the panel and
  // ends out on the backdrop is dispatched to the backdrop as a click, and
  // must not throw away what the drag was doing.
  let pressed = false;
  modal.addEventListener('pointerdown', (evt) => {
    pressed = evt.target === modal;
  });
  modal.addEventListener('click', (evt) => {
    if (evt.target === modal && pressed) cancel();
  });
}

/** The highest popup open, or null. */
function topPopup() {
  let top = null;
  for (const p of popups) {
    if (!p.modal.hidden && (!top || p.layer > top.layer)) top = p;
  }
  return top;
}

/**
 * A pointer drag on `el`: the pointer captured, `onMove` on every move, and
 * `onDone` with the last event once it is let go or taken away. The press's
 * default is prevented unless `keepDefault`, which a press that should still
 * take the focus off a text box asks for.
 */
function beginDrag(el, evt, onMove, onDone, keepDefault = false) {
  el.setPointerCapture(evt.pointerId);
  if (!keepDefault) evt.preventDefault();
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    if (onDone) onDone(ev);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
