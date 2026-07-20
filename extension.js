/**
 * Rounded Gaps - GNOME Shell Extension (GNOME 50+, Wayland)
 *
 * Combined extension:
 * - Hyprland-style gaps for maximized and half-tiled windows
 * - Transparent top bar with pill-shaped indicators (via stylesheet.css)
 * - Forced rounded corners on ALL windows (Chrome, Firefox, etc.)
 * - Fully configurable via preferences UI
 *
 * License: GPL-3.0
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_GAP = 8;
const DEFAULT_RADIUS = 12;
const DEFAULT_ANIMATION_DELAY = 250;

export default class RoundedGapsExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._signals = [];
        this._windowSignals = new Map();
        this._processing = new Set();
        this._pendingWindows = new Set();
        this._settings = null;
        this._timeouts = [];
        this._settingsConnections = [];
        this._corneredActors = new Set();
        this._shaderDeclarations = null;
        this._shaderCode = null;
    }

    enable() {
        try {
            this._settings = this.getSettings();
        } catch (e) {
            this._settings = null;
        }

        this._loadShader();

        if (this._getSetting('gaps-enabled', true)) {
            this._enableGaps();
        }

        if (this._getSetting('topbar-enabled', true)) {
            this._enableTopBar();
        }

        if (this._getSetting('corners-enabled', true)) {
            this._enableCorners();
        }

        // Watch for settings changes
        if (this._settings) {
            this._settingsConnections.push(
                this._settings.connect('changed::gaps-enabled', () => {
                    if (this._settings.get_boolean('gaps-enabled'))
                        this._enableGaps();
                    else
                        this._disableGaps();
                })
            );
            this._settingsConnections.push(
                this._settings.connect('changed::topbar-enabled', () => {
                    if (this._settings.get_boolean('topbar-enabled'))
                        this._enableTopBar();
                    else
                        this._disableTopBar();
                })
            );
            this._settingsConnections.push(
                this._settings.connect('changed::corners-enabled', () => {
                    if (this._settings.get_boolean('corners-enabled'))
                        this._enableCorners();
                    else
                        this._disableCorners();
                })
            );
            this._settingsConnections.push(
                this._settings.connect('changed::corner-radius', () => {
                    if (this._getSetting('corners-enabled', true)) {
                        this._disableCorners();
                        this._enableCorners();
                    }
                })
            );
        }
    }

    disable() {
        this._disableGaps();
        this._disableTopBar();
        this._disableCorners();

        if (this._settings) {
            for (const id of this._settingsConnections) {
                this._settings.disconnect(id);
            }
        }
        this._settingsConnections = [];
        this._settings = null;
    }

    // ===================== SHADER LOADING =====================

    _loadShader() {
        try {
            const extensionDir = this.path;
            const shaderFile = Gio.File.new_for_path(`${extensionDir}/shader/rounded_corners.frag`);
            const [ok, contents] = shaderFile.load_contents(null);
            if (ok) {
                const decoder = new TextDecoder();
                const shaderSource = decoder.decode(contents);

                // Split into declarations and main body for add_glsl_snippet
                const parts = shaderSource.split(/^.*?void\s+main\s*\(\s*\)\s*/m);
                if (parts.length >= 2) {
                    this._shaderDeclarations = parts[0].trim();
                    this._shaderCode = parts[1].trim().replace(/^\{/, '').replace(/\}$/, '').trim();
                }
            }
        } catch (e) {
            log(`[Rounded Gaps] Failed to load shader: ${e.message}`);
            this._shaderDeclarations = null;
            this._shaderCode = null;
        }
    }

    // ===================== SETTINGS HELPERS =====================

    _getSetting(key, defaultVal) {
        if (this._settings) {
            try {
                if (typeof defaultVal === 'boolean')
                    return this._settings.get_boolean(key);
                if (typeof defaultVal === 'number')
                    return this._settings.get_int(key);
                if (typeof defaultVal === 'string')
                    return this._settings.get_string(key);
            } catch (e) {}
        }
        return defaultVal;
    }

    // ===================== WINDOW GAPS =====================

    _enableGaps() {
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win && win.get_window_type() === Meta.WindowType.NORMAL) {
                this._trackWindow(win);
                this._applyGapsImmediate(win);
            }
        }

        this._connectSignal(global.display, 'grab-op-end', (display, window) => {
            if (window && window.get_window_type() === Meta.WindowType.NORMAL) {
                this._scheduleApply(window);
            }
        });

        this._connectSignal(global.display, 'window-created', (display, window) => {
            if (window && window.get_window_type() === Meta.WindowType.NORMAL) {
                this._trackWindow(window);
                this._scheduleApply(window);
            }
        });

        this._connectSignal(global.display, 'restacked', () => {
            for (const actor of global.get_window_actors()) {
                const win = actor.meta_window;
                if (win && win.get_window_type() === Meta.WindowType.NORMAL) {
                    if (this._getMaximizeFlags(win) !== 0 && !this._processing.has(win)) {
                        this._scheduleApply(win);
                    }
                }
            }
        });
    }

    _disableGaps() {
        for (const id of this._timeouts) {
            GLib.source_remove(id);
        }
        this._timeouts = [];

        for (const signal of this._signals) {
            try { signal.obj.disconnect(signal.id); } catch (e) {}
        }
        this._signals = [];

        for (const [win, ids] of this._windowSignals) {
            for (const id of ids) {
                try { win.disconnect(id); } catch (e) {}
            }
        }
        this._windowSignals.clear();
        this._processing.clear();
        this._pendingWindows.clear();
    }

    _connectSignal(obj, signal, callback) {
        const id = obj.connect(signal, callback);
        this._signals.push({ obj, id });
    }

    _getMaximizeFlags(win) {
        if (win.get_maximize_flags)
            return win.get_maximize_flags();
        if (win.get_maximized)
            return win.get_maximized();
        return 0;
    }

    _unmaximizeWindow(win, flags) {
        if (win.set_unmaximize_flags) {
            win.set_unmaximize_flags(flags);
            win.unmaximize();
        } else {
            win.unmaximize(flags);
        }
    }

    _trackWindow(win) {
        if (!win || this._windowSignals.has(win))
            return;

        const sizeId = win.connect('size-changed', () => {
            if (!this._processing.has(win) && !this._pendingWindows.has(win)) {
                if (this._getMaximizeFlags(win) !== 0) {
                    this._scheduleApply(win);
                }
            }
        });

        const unmanagedId = win.connect('unmanaged', () => {
            this._untrackWindow(win);
        });

        this._windowSignals.set(win, [sizeId, unmanagedId]);
    }

    _untrackWindow(win) {
        const ids = this._windowSignals.get(win);
        if (ids) {
            for (const id of ids) {
                try { win.disconnect(id); } catch (e) {}
            }
            this._windowSignals.delete(win);
        }
        this._processing.delete(win);
        this._pendingWindows.delete(win);
    }

    _scheduleApply(win) {
        if (this._pendingWindows.has(win) || this._processing.has(win))
            return;

        this._pendingWindows.add(win);
        const delay = this._getSetting('animation-delay', DEFAULT_ANIMATION_DELAY);

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._removeTimeout(id);
            this._pendingWindows.delete(win);
            this._applyGapsImmediate(win);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.push(id);
    }

    _removeTimeout(id) {
        const idx = this._timeouts.indexOf(id);
        if (idx !== -1) this._timeouts.splice(idx, 1);
    }

    _applyGapsImmediate(win) {
        if (!win || this._processing.has(win))
            return;

        const maximized = this._getMaximizeFlags(win);
        if (maximized === 0)
            return;

        const gap = this._getSetting('gap-size', DEFAULT_GAP);
        const workArea = win.get_work_area_current_monitor();

        this._processing.add(win);

        try {
            if (maximized === Meta.MaximizeFlags.BOTH) {
                this._unmaximizeWindow(win, Meta.MaximizeFlags.BOTH);
                win.move_resize_frame(
                    true,
                    workArea.x + gap,
                    workArea.y + gap,
                    workArea.width - (gap * 2),
                    workArea.height - (gap * 2)
                );

            } else if (maximized === Meta.MaximizeFlags.VERTICAL) {
                const rect = win.get_frame_rect();
                const halfWidth = Math.floor(workArea.width / 2);
                const isLeft = rect.x < workArea.x + halfWidth;

                this._unmaximizeWindow(win, Meta.MaximizeFlags.VERTICAL);

                if (isLeft) {
                    win.move_resize_frame(
                        true,
                        workArea.x + gap,
                        workArea.y + gap,
                        halfWidth - gap - Math.floor(gap / 2),
                        workArea.height - (gap * 2)
                    );
                } else {
                    win.move_resize_frame(
                        true,
                        workArea.x + halfWidth + Math.floor(gap / 2),
                        workArea.y + gap,
                        halfWidth - gap - Math.floor(gap / 2),
                        workArea.height - (gap * 2)
                    );
                }

            } else if (maximized === Meta.MaximizeFlags.HORIZONTAL) {
                this._unmaximizeWindow(win, Meta.MaximizeFlags.HORIZONTAL);
                const rect = win.get_frame_rect();
                win.move_resize_frame(
                    true,
                    workArea.x + gap,
                    rect.y,
                    workArea.width - (gap * 2),
                    rect.height
                );

            } else {
                this._processing.delete(win);
                return;
            }
        } catch (e) {
            this._processing.delete(win);
            return;
        }

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._processing.delete(win);
            this._removeTimeout(id);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.push(id);
    }

    // ===================== ROUNDED CORNERS =====================

    _enableCorners() {
        if (!this._shaderDeclarations || !this._shaderCode)
            return;

        const radius = this._getSetting('corner-radius', DEFAULT_RADIUS);

        RoundedCornersEffect._shaderDeclarations = this._shaderDeclarations;
        RoundedCornersEffect._shaderCode = this._shaderCode;
        RoundedCornersEffect._radius = radius;

        for (const actor of global.get_window_actors()) {
            this._applyCornerEffect(actor);
        }

        this._cornerAddedSignal = global.window_group.connect('child-added', (group, actor) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._applyCornerEffect(actor);
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.push(id);
        });
    }

    _disableCorners() {
        if (this._cornerAddedSignal) {
            global.window_group.disconnect(this._cornerAddedSignal);
            this._cornerAddedSignal = null;
        }

        for (const actor of this._corneredActors) {
            try {
                const effect = actor.get_effect('rounded-gaps-corners');
                if (effect)
                    actor.remove_effect(effect);
            } catch (e) {}
        }
        this._corneredActors.clear();
    }

    _applyCornerEffect(actor) {
        if (!actor || !this._shaderDeclarations || !this._shaderCode)
            return;

        // Only apply to actual application windows, NOT popups/menus/dialogs
        if (!actor.meta_window)
            return;

        const winType = actor.meta_window.get_window_type();
        if (winType !== Meta.WindowType.NORMAL)
            return;

        // Skip if already applied
        if (actor.get_effect('rounded-gaps-corners'))
            return;

        try {
            const effect = new RoundedCornersEffect();
            actor.add_effect_with_name('rounded-gaps-corners', effect);
            this._corneredActors.add(actor);

            actor.connect('destroy', () => {
                this._corneredActors.delete(actor);
            });
        } catch (e) {
            log(`[Rounded Gaps] Failed to apply corner effect: ${e.message}`);
        }
    }

    // ===================== TOP BAR =====================
    // Makes the panel background transparent (85% solid on buttons).
    // Popups are left to GNOME default — no popup styling.

    _enableTopBar() {
        Main.panel.add_style_class_name('transparent-panel');
        Main.panel.set_style('background-color: transparent;');
    }

    _disableTopBar() {
        Main.panel.remove_style_class_name('transparent-panel');
        Main.panel.set_style('');
    }
}

// ===================== ROUNDED CORNERS GLSL EFFECT =====================

const RoundedCornersEffect = GObject.registerClass(
    {},
    class RoundedCornersEffect extends Shell.GLSLEffect {
        static _shaderDeclarations = '';
        static _shaderCode = '';
        static _radius = 12;

        _init() {
            super._init();
            this._uBounds = this.get_uniform_location('bounds');
            this._uClipRadius = this.get_uniform_location('clipRadius');
            this._uPixelStep = this.get_uniform_location('pixelStep');
        }

        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                RoundedCornersEffect._shaderDeclarations,
                RoundedCornersEffect._shaderCode,
                false
            );
        }

        vfunc_paint_target(node, paintContext) {
            const actor = this.get_actor();
            if (actor && actor.meta_window) {
                const actorWidth = actor.get_width();
                const actorHeight = actor.get_height();

                if (actorWidth > 0 && actorHeight > 0) {
                    const radius = RoundedCornersEffect._radius;

                    // Get the window frame rect and buffer rect to find shadow offsets
                    const frameRect = actor.meta_window.get_frame_rect();
                    const bufferRect = actor.meta_window.get_buffer_rect();

                    // Calculate the offset of the actual window content within the actor
                    // (actor includes shadows around the window)
                    const offsetX = frameRect.x - bufferRect.x;
                    const offsetY = frameRect.y - bufferRect.y;
                    const windowWidth = frameRect.width;
                    const windowHeight = frameRect.height;

                    const bounds = [
                        offsetX,
                        offsetY,
                        offsetX + windowWidth,
                        offsetY + windowHeight
                    ];

                    this.set_uniform_float(this._uBounds, 4, bounds);
                    this.set_uniform_float(this._uClipRadius, 1, [radius]);
                    this.set_uniform_float(this._uPixelStep, 2, [1.0 / actorWidth, 1.0 / actorHeight]);
                }
            }
            super.vfunc_paint_target(node, paintContext);
        }
    }
);
