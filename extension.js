/**
 * Rounded Gaps - GNOME Shell Extension (GNOME 50, Mutter 18, Wayland)
 *
 * Features:
 * - Hyprland-style gaps for maximized and half-tiled windows
 * - Custom keybinding handling (Super+Arrow keys)
 * - Edge-drag detection for mouse-based tiling
 * - Transparent top bar with purple-themed quick settings
 * - Aggressive size enforcement (Brave/Chrome fix)
 *
 * License: GPL-3.0
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const TileState = {
   NONE: 0,
   LEFT: 1,
   RIGHT: 2,
   MAXIMIZED: 3,
};

export default class RoundedGapsExtension extends Extension {
   constructor(metadata) {
      super(metadata);
      this._settings = null;
      this._signals = [];
      this._timeouts = [];
      this._tileState = new Map();
      this._originalRects = new Map();
      this._tiledRects = new Map();
      this._processing = new Set();
      this._sizeSignals = new Map();

      this._savedEdgeTiling = null;
      this._savedTileLeft = null;
      this._savedTileRight = null;
      this._savedWmMaximize = null;
      this._savedWmUnmaximize = null;

      this._mutterSettings = null;
      this._mutterKeybindingsSettings = null;
      this._wmKeybindingsSettings = null;
      this._settingsConnections = [];
      this._quickSettingsSignal = null;
   }

   enable() {
      this._settings = this.getSettings();

      if (this._getSetting("gaps-enabled", true)) this._enableGaps();

      if (this._getSetting("topbar-enabled", true)) this._enableTopBar();

      this._settingsConnections.push(
         this._settings.connect("changed::gaps-enabled", () => {
            if (this._settings.get_boolean("gaps-enabled")) this._enableGaps();
            else this._disableGaps();
         }),
         this._settings.connect("changed::topbar-enabled", () => {
            if (this._settings.get_boolean("topbar-enabled"))
               this._enableTopBar();
            else this._disableTopBar();
         }),
      );
   }

   disable() {
      this._disableGaps();
      this._disableTopBar();

      if (this._settings) {
         for (const id of this._settingsConnections)
            this._settings.disconnect(id);
      }
      this._settingsConnections = [];
      this._settings = null;
   }

   // =========================================================================
   // SETTINGS
   // =========================================================================

   _getSetting(key, defaultVal) {
      if (!this._settings) return defaultVal;
      try {
         if (typeof defaultVal === "boolean")
            return this._settings.get_boolean(key);
         if (typeof defaultVal === "number") return this._settings.get_int(key);
      } catch (e) {
         return defaultVal;
      }
   }

   // =========================================================================
   // GAPS
   // =========================================================================

   _enableGaps() {
      this._mutterSettings = new Gio.Settings({
         schema_id: "org.gnome.mutter",
      });
      this._savedEdgeTiling = this._mutterSettings.get_boolean("edge-tiling");
      this._mutterSettings.set_boolean("edge-tiling", false);

      this._mutterKeybindingsSettings = new Gio.Settings({
         schema_id: "org.gnome.mutter.keybindings",
      });
      this._savedTileLeft = this._mutterKeybindingsSettings.get_strv("toggle-tiled-left");
      this._savedTileRight = this._mutterKeybindingsSettings.get_strv("toggle-tiled-right");
      this._mutterKeybindingsSettings.set_strv("toggle-tiled-left", []);
      this._mutterKeybindingsSettings.set_strv("toggle-tiled-right", []);

      this._wmKeybindingsSettings = new Gio.Settings({
         schema_id: "org.gnome.desktop.wm.keybindings",
      });
      this._savedWmMaximize = this._wmKeybindingsSettings.get_strv("maximize");
      this._savedWmUnmaximize = this._wmKeybindingsSettings.get_strv("unmaximize");
      this._wmKeybindingsSettings.set_strv("maximize", []);
      this._wmKeybindingsSettings.set_strv("unmaximize", []);

      const bindingFlags = Meta.KeyBindingFlags.NONE;
      const bindingModes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

      Main.wm.addKeybinding(
         "tile-left",
         this._settings,
         bindingFlags,
         bindingModes,
         this._onTileLeft.bind(this),
      );
      Main.wm.addKeybinding(
         "tile-right",
         this._settings,
         bindingFlags,
         bindingModes,
         this._onTileRight.bind(this),
      );
      Main.wm.addKeybinding(
         "tile-maximize",
         this._settings,
         bindingFlags,
         bindingModes,
         this._onTileMaximize.bind(this),
      );
      Main.wm.addKeybinding(
         "tile-restore",
         this._settings,
         bindingFlags,
         bindingModes,
         this._onTileRestore.bind(this),
      );

      // Apply gaps to existing maximized/tiled windows
      for (const actor of global.get_window_actors()) {
         const win = actor.meta_window;
         if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) continue;
         const flags = this._getMaximizeFlags(win);
         if (flags === Meta.MaximizeFlags.BOTH) {
            this._addTimeout(100, () =>
               this._tileWindow(win, TileState.MAXIMIZED),
            );
         } else if (flags === Meta.MaximizeFlags.VERTICAL) {
            this._addTimeout(100, () => {
               const rect = win.get_frame_rect();
               const workArea = win.get_work_area_current_monitor();
               const half = Math.floor(workArea.width / 2);
               this._tileWindow(
                  win,
                  rect.x < workArea.x + half ? TileState.LEFT : TileState.RIGHT,
               );
            });
         }
      }

      this._connectSignal(global.display, "grab-op-end", (_display, window) => {
         if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
         if (this._processing.has(window)) return;
         this._addTimeout(50, () => this._detectEdgeDrag(window));
      });

      this._connectSignal(
         global.display,
         "window-created",
         (_display, window) => {
            if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
               return;
            const unmId = window.connect("unmanaged", () => {
               this._disconnectSizeSignal(window);
               this._tileState.delete(window);
               this._originalRects.delete(window);
               this._tiledRects.delete(window);
               this._processing.delete(window);
               try {
                  window.disconnect(unmId);
               } catch (e) {}
            });
            this._addTimeout(300, () => {
               if (!window || this._processing.has(window)) return;
               const flags = this._getMaximizeFlags(window);
               if (flags === Meta.MaximizeFlags.BOTH) {
                  this._tileWindow(window, TileState.MAXIMIZED);
               } else if (flags === Meta.MaximizeFlags.VERTICAL) {
                  const rect = window.get_frame_rect();
                  const workArea = window.get_work_area_current_monitor();
                  const half = Math.floor(workArea.width / 2);
                  this._tileWindow(
                     window,
                     rect.x < workArea.x + half
                        ? TileState.LEFT
                        : TileState.RIGHT,
                  );
               }
            });
         },
      );
   }

   _disableGaps() {
      ["tile-left", "tile-right", "tile-maximize", "tile-restore"].forEach(
         (k) => {
            try {
               Main.wm.removeKeybinding(k);
            } catch (e) {}
         },
      );

      if (this._mutterSettings && this._savedEdgeTiling !== null)
         this._mutterSettings.set_boolean("edge-tiling", this._savedEdgeTiling);

      if (this._mutterKeybindingsSettings) {
         if (this._savedTileLeft !== null)
            this._mutterKeybindingsSettings.set_strv(
               "toggle-tiled-left",
               this._savedTileLeft,
            );
         if (this._savedTileRight !== null)
            this._mutterKeybindingsSettings.set_strv(
               "toggle-tiled-right",
               this._savedTileRight,
            );
      }

      if (this._wmKeybindingsSettings) {
         if (this._savedWmMaximize !== null)
            this._wmKeybindingsSettings.set_strv(
               "maximize",
               this._savedWmMaximize,
            );
         if (this._savedWmUnmaximize !== null)
            this._wmKeybindingsSettings.set_strv(
               "unmaximize",
               this._savedWmUnmaximize,
            );
      }

      this._mutterSettings = null;
      this._mutterKeybindingsSettings = null;
      this._wmKeybindingsSettings = null;
      this._savedEdgeTiling = this._savedTileLeft = this._savedTileRight = null;
      this._savedWmMaximize = this._savedWmUnmaximize = null;

      for (const [win, sigId] of this._sizeSignals) {
         try {
            win.disconnect(sigId);
         } catch (e) {}
      }
      this._sizeSignals.clear();

      for (const signal of this._signals) {
         try {
            signal.obj.disconnect(signal.id);
         } catch (e) {}
      }
      this._signals = [];

      for (const id of this._timeouts) GLib.source_remove(id);
      this._timeouts = [];

      this._tileState.clear();
      this._originalRects.clear();
      this._tiledRects.clear();
      this._processing.clear();
   }

   // =========================================================================
   // KEYBINDING HANDLERS
   // =========================================================================

   _onTileLeft() {
      const win = global.display.focus_window;
      if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return;
      this._saveOriginalRect(win);
      this._tileWindow(win, TileState.LEFT);
   }

   _onTileRight() {
      const win = global.display.focus_window;
      if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return;
      this._saveOriginalRect(win);
      this._tileWindow(win, TileState.RIGHT);
   }

   _onTileMaximize() {
      const win = global.display.focus_window;
      if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return;
      this._saveOriginalRect(win);
      this._tileWindow(win, TileState.MAXIMIZED);
   }

   _onTileRestore() {
      const win = global.display.focus_window;
      if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return;
      const state = this._tileState.get(win) || TileState.NONE;
      if (state !== TileState.NONE) this._restoreWindow(win);
      else win.minimize();
   }

   // =========================================================================
   // EDGE DRAG DETECTION
   // =========================================================================

   _detectEdgeDrag(win) {
      const rect = win.get_frame_rect();
      const workArea = win.get_work_area_current_monitor();
      const threshold = 5;

      const atLeft = Math.abs(rect.x - workArea.x) < threshold;
      const atRight =
         Math.abs(rect.x + rect.width - (workArea.x + workArea.width)) <
         threshold;
      const atTop = Math.abs(rect.y - workArea.y) < threshold;
      const fillsHeight = rect.height >= workArea.height - threshold * 2;

      if (atTop && !atLeft && !atRight) {
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.MAXIMIZED);
      } else if (atLeft && fillsHeight) {
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.LEFT);
      } else if (atRight && fillsHeight) {
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.RIGHT);
      }
   }

   // =========================================================================
   // TILING LOGIC
   // =========================================================================

   _saveOriginalRect(win) {
      const state = this._tileState.get(win) || TileState.NONE;
      if (state === TileState.NONE && !this._originalRects.has(win)) {
         const rect = win.get_frame_rect();
         this._originalRects.set(win, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
         });
      }
   }

   _calculateTileRect(win, state) {
      const gap = this._getSetting("gap-size", 8);
      const workArea = win.get_work_area_current_monitor();
      const half = Math.floor(workArea.width / 2);

      switch (state) {
         case TileState.MAXIMIZED:
            return {
               x: workArea.x + gap,
               y: workArea.y + gap,
               width: workArea.width - gap * 2,
               height: workArea.height - gap * 2,
            };
         case TileState.LEFT:
            return {
               x: workArea.x + gap,
               y: workArea.y + gap,
               width: half - gap - Math.floor(gap / 2),
               height: workArea.height - gap * 2,
            };
         case TileState.RIGHT:
            return {
               x: workArea.x + half + Math.floor(gap / 2),
               y: workArea.y + gap,
               width: half - gap - Math.floor(gap / 2),
               height: workArea.height - gap * 2,
            };
         default:
            return null;
      }
   }

   _tileWindow(win, state) {
      if (this._processing.has(win)) return;

      const target = this._calculateTileRect(win, state);
      if (!target) return;

      this._processing.add(win);
      this._tileState.set(win, state);
      this._tiledRects.set(win, target);

      const flags = this._getMaximizeFlags(win);
      if (flags !== 0) this._unmaximizeWindow(win, flags);

      const delay = flags !== 0 ? this._getSetting("animation-delay", 250) : 50;

      this._addTimeout(delay, () => {
         try {
            win.move_frame(true, target.x, target.y);
            win.move_resize_frame(
               true,
               target.x,
               target.y,
               target.width,
               target.height,
            );
         } catch (e) {}
         this._addTimeout(100, () => {
            this._connectSizeEnforcement(win);
            this._processing.delete(win);
         });
      });
   }

   _connectSizeEnforcement(win) {
      this._disconnectSizeSignal(win);
      const sigId = win.connect("size-changed", () => {
         if (this._processing.has(win)) return;
         const saved = this._tiledRects.get(win);
         if (!saved) return;
         const rect = win.get_frame_rect();
         if (
            Math.abs(rect.x - saved.x) > 2 ||
            Math.abs(rect.y - saved.y) > 2 ||
            Math.abs(rect.width - saved.width) > 2 ||
            Math.abs(rect.height - saved.height) > 2
         ) {
            this._processing.add(win);
            try {
               win.move_frame(true, saved.x, saved.y);
               win.move_resize_frame(
                  true,
                  saved.x,
                  saved.y,
                  saved.width,
                  saved.height,
               );
            } catch (e) {}
            this._addTimeout(50, () => this._processing.delete(win));
         }
      });
      this._sizeSignals.set(win, sigId);
   }

   _disconnectSizeSignal(win) {
      const sigId = this._sizeSignals.get(win);
      if (sigId !== undefined) {
         try {
            win.disconnect(sigId);
         } catch (e) {}
         this._sizeSignals.delete(win);
      }
   }

   _restoreWindow(win) {
      if (this._processing.has(win)) return;
      const original = this._originalRects.get(win);
      this._tileState.set(win, TileState.NONE);
      this._tiledRects.delete(win);
      this._disconnectSizeSignal(win);
      this._processing.add(win);
      if (original) {
         try {
            win.move_frame(true, original.x, original.y);
            win.move_resize_frame(
               true,
               original.x,
               original.y,
               original.width,
               original.height,
            );
         } catch (e) {}
         this._originalRects.delete(win);
      }
      this._addTimeout(300, () => this._processing.delete(win));
   }

   // =========================================================================
   // MUTTER 18 COMPATIBILITY
   // =========================================================================

   _getMaximizeFlags(win) {
      if (win.get_maximize_flags) return win.get_maximize_flags();
      if (win.get_maximized) return win.get_maximized();
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

   // =========================================================================
   // SIGNAL / TIMEOUT HELPERS
   // =========================================================================

   _connectSignal(obj, signal, callback) {
      const id = obj.connect(signal, callback);
      this._signals.push({ obj, id });
      return id;
   }

   _addTimeout(ms, callback) {
      const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
         this._removeTimeout(id);
         callback();
         return GLib.SOURCE_REMOVE;
      });
      this._timeouts.push(id);
      return id;
   }

   _removeTimeout(id) {
      const idx = this._timeouts.indexOf(id);
      if (idx !== -1) this._timeouts.splice(idx, 1);
   }

   // =========================================================================
   // TOP BAR
   // =========================================================================

   _enableTopBar() {
      Main.panel.add_style_class_name("transparent-panel");
      Main.panel.set_style(
         "background-color: transparent; border: none; box-shadow: none;",
      );

      const qs = Main.panel.statusArea.quickSettings;
      if (qs?.menu) {
         this._quickSettingsSignal = qs.menu.connect(
            "open-state-changed",
            (_menu, open) => {
               if (open) {
                  this._addTimeout(50, () => this._recolorQuickSettings());
                  this._addTimeout(300, () => this._recolorQuickSettings());
               }
            },
         );
         // Recolor once on load in case tiles are already built
         this._addTimeout(1000, () => this._recolorQuickSettings());
      }
   }

   _disableTopBar() {
      Main.panel.remove_style_class_name("transparent-panel");
      Main.panel.set_style("");

      const qs = Main.panel.statusArea.quickSettings;
      if (qs?.menu && this._quickSettingsSignal) {
         try {
            qs.menu.disconnect(this._quickSettingsSignal);
         } catch (e) {}
      }
      this._quickSettingsSignal = null;
   }

   /**
    * Walk the quick-settings grid and apply purple theming to elements
    * that can't be styled via CSS alone (barlevel fill, chevron icons).
    *
    * Class names sourced from GNOME Shell JS:
    *   "quick-toggle-menu-button" — split-tile chevron button
    *   "quick-toggle-separator"   — divider between label and chevron
    *   "barlevel"                 — slider fill bar
    *   "icon-button" in "quick-slider" — mute/settings icon next to slider
    */
   _recolorQuickSettings() {
      try {
         const qs = Main.panel.statusArea.quickSettings;
         if (!qs) return;

         // Walk from _grid to reach all tiles and sliders
         const root = qs.menu._grid ?? qs.menu.box ?? qs.menu.actor ?? qs.menu;

         this._walkActor(root, (actor) => {
            const sc = actor.get_style_class_name?.() ?? "";
            const psc = actor.get_parent?.()?.get_style_class_name?.() ?? "";

            if (sc.includes("quick-toggle-menu-button")) {
               actor.set_style(
                  "color: #a277ff;" +
                     "background-color: rgba(162,119,255,0.18);" +
                     "border-radius: 0 14px 14px 0;" +
                     "border: none;" +
                     "border-left: 1px solid rgba(162,119,255,0.25);",
               );
            }

            if (psc.includes("quick-toggle-menu-button")) {
               actor.set_style("color: #a277ff;");
            }

            if (sc.includes("quick-toggle-separator")) {
               actor.set_style("background-color: transparent; width: 0;");
            }

            if (sc.includes("barlevel")) {
               actor.set_style(
                  "-barlevel-background-color: rgba(162,119,255,0.25);" +
                     "-barlevel-active-background-color: #a277ff;" +
                     "-barlevel-overdrive-color: #c9b0ff;",
               );
            }

            if (sc.includes("icon-button") && psc.includes("quick-slider")) {
               actor.set_style("color: #a277ff;");
            }
         });
      } catch (e) {}
   }

   _walkActor(actor, cb) {
      if (!actor) return;
      try {
         cb(actor);
      } catch (e) {}
      const n = actor.get_n_children?.() ?? 0;
      for (let i = 0; i < n; i++)
         this._walkActor(actor.get_child_at_index(i), cb);
   }
}
