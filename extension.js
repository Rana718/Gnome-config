/**
 * Rounded Gaps - GNOME Shell Extension (GNOME 50, Mutter 18, Wayland)
 *
 * WinTile-style approach: disables GNOME's built-in edge tiling and
 * keybindings, handles all tiling ourselves with proper gaps.
 *
 * Features:
 * - Hyprland-style gaps for maximized and half-tiled windows
 * - Custom keybinding handling (Super+Arrow keys)
 * - Edge-drag detection for mouse-based tiling
 * - Transparent top bar (via stylesheet.css)
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

// Tile states for tracking window position
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
      this._tileState = new Map(); // Meta.Window -> TileState
      this._originalRects = new Map(); // Meta.Window -> {x, y, width, height}
      this._tiledRects = new Map(); // Meta.Window -> {x, y, width, height} target after gaps
      this._processing = new Set(); // Windows currently being repositioned

      // Per-window size-changed signal IDs for aggressive enforcement
      this._sizeSignals = new Map(); // Meta.Window -> signal id

      // Saved GNOME settings to restore on disable
      this._savedEdgeTiling = null;
      this._savedTileLeft = null;
      this._savedTileRight = null;
      this._savedWmMaximize = null;
      this._savedWmUnmaximize = null;

      // GSettings objects for mutter/wm
      this._mutterSettings = null;
      this._mutterKeybindingsSettings = null;
      this._wmKeybindingsSettings = null;

      // Settings change connections
      this._settingsConnections = [];
   }

   enable() {
      this._settings = this.getSettings();

      if (this._getSetting("gaps-enabled", true)) {
         this._enableGaps();
      }

      if (this._getSetting("topbar-enabled", true)) {
         this._enableTopBar();
      }

      // Watch for live settings changes
      this._settingsConnections.push(
         this._settings.connect("changed::gaps-enabled", () => {
            if (this._settings.get_boolean("gaps-enabled")) this._enableGaps();
            else this._disableGaps();
         }),
      );
      this._settingsConnections.push(
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

      // Disconnect settings watchers
      if (this._settings) {
         for (const id of this._settingsConnections) {
            this._settings.disconnect(id);
         }
      }
      this._settingsConnections = [];
      this._settings = null;
   }

   // =========================================================================
   // SETTINGS HELPERS
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
      // --- Step 1: Disable GNOME's built-in edge tiling ---
      this._mutterSettings = new Gio.Settings({
         schema_id: "org.gnome.mutter",
      });
      this._savedEdgeTiling = this._mutterSettings.get_boolean("edge-tiling");
      this._mutterSettings.set_boolean("edge-tiling", false);

      // --- Step 2: Disable mutter toggle-tiled-left/right keybindings ---
      this._mutterKeybindingsSettings = new Gio.Settings({
         schema_id: "org.gnome.mutter.keybindings",
      });
      this._savedTileLeft =
         this._mutterKeybindingsSettings.get_strv("toggle-tiled-left");
      this._savedTileRight =
         this._mutterKeybindingsSettings.get_strv("toggle-tiled-right");
      this._mutterKeybindingsSettings.set_strv("toggle-tiled-left", []);
      this._mutterKeybindingsSettings.set_strv("toggle-tiled-right", []);

      // --- Step 3: Disable default WM maximize/unmaximize keybindings ---
      this._wmKeybindingsSettings = new Gio.Settings({
         schema_id: "org.gnome.desktop.wm.keybindings",
      });
      this._savedWmMaximize = this._wmKeybindingsSettings.get_strv("maximize");
      this._savedWmUnmaximize =
         this._wmKeybindingsSettings.get_strv("unmaximize");
      this._wmKeybindingsSettings.set_strv("maximize", []);
      this._wmKeybindingsSettings.set_strv("unmaximize", []);

      // --- Step 4: Register our keybindings ---
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

      // --- Step 5: Apply gaps to already maximized/tiled windows ---
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
               const halfWidth = Math.floor(workArea.width / 2);
               if (rect.x < workArea.x + halfWidth) {
                  this._tileWindow(win, TileState.LEFT);
               } else {
                  this._tileWindow(win, TileState.RIGHT);
               }
            });
         }
      }

      // --- Step 6: Detect edge drags via grab-op-end ---
      this._connectSignal(global.display, "grab-op-end", (display, window) => {
         if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
         if (this._processing.has(window)) return;

         this._addTimeout(50, () => {
            this._detectEdgeDrag(window);
         });
      });

      // --- Step 7: Track window destruction + apply gaps to newly created maximized windows ---
      this._connectSignal(
         global.display,
         "window-created",
         (display, window) => {
            if (window && window.get_window_type() === Meta.WindowType.NORMAL) {
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

               // Check if window opens maximized (GNOME remembers last state)
               this._addTimeout(300, () => {
                  if (!window || this._processing.has(window)) return;
                  const flags = this._getMaximizeFlags(window);
                  if (flags === Meta.MaximizeFlags.BOTH) {
                     this._tileWindow(window, TileState.MAXIMIZED);
                  } else if (flags === Meta.MaximizeFlags.VERTICAL) {
                     const rect = window.get_frame_rect();
                     const workArea = window.get_work_area_current_monitor();
                     const halfWidth = Math.floor(workArea.width / 2);
                     if (rect.x < workArea.x + halfWidth) {
                        this._tileWindow(window, TileState.LEFT);
                     } else {
                        this._tileWindow(window, TileState.RIGHT);
                     }
                  }
               });
            }
         },
      );
   }

   _disableGaps() {
      // Remove our keybindings
      try {
         Main.wm.removeKeybinding("tile-left");
      } catch (e) {}
      try {
         Main.wm.removeKeybinding("tile-right");
      } catch (e) {}
      try {
         Main.wm.removeKeybinding("tile-maximize");
      } catch (e) {}
      try {
         Main.wm.removeKeybinding("tile-restore");
      } catch (e) {}

      // Restore GNOME's edge-tiling
      if (this._mutterSettings && this._savedEdgeTiling !== null) {
         this._mutterSettings.set_boolean("edge-tiling", this._savedEdgeTiling);
      }

      // Restore mutter keybindings
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

      // Restore WM keybindings
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
      this._savedEdgeTiling = null;
      this._savedTileLeft = null;
      this._savedTileRight = null;
      this._savedWmMaximize = null;
      this._savedWmUnmaximize = null;

      // Disconnect all per-window size signals
      for (const [win, sigId] of this._sizeSignals) {
         try {
            win.disconnect(sigId);
         } catch (e) {}
      }
      this._sizeSignals.clear();

      // Disconnect all signals
      for (const signal of this._signals) {
         try {
            signal.obj.disconnect(signal.id);
         } catch (e) {}
      }
      this._signals = [];

      // Clear all timeouts
      for (const id of this._timeouts) {
         GLib.source_remove(id);
      }
      this._timeouts = [];

      // Clear state
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

      const currentState = this._tileState.get(win) || TileState.NONE;

      if (currentState !== TileState.NONE) {
         this._restoreWindow(win);
      } else {
         win.minimize();
      }
   }

   // =========================================================================
   // EDGE DRAG DETECTION
   // =========================================================================

   _detectEdgeDrag(win) {
      const rect = win.get_frame_rect();
      const workArea = win.get_work_area_current_monitor();

      const threshold = 5;

      const atLeftEdge = Math.abs(rect.x - workArea.x) < threshold;
      const atRightEdge =
         Math.abs(rect.x + rect.width - (workArea.x + workArea.width)) <
         threshold;
      const atTopEdge = Math.abs(rect.y - workArea.y) < threshold;

      const fillsHeight = rect.height >= workArea.height - threshold * 2;

      if (atTopEdge && !atLeftEdge && !atRightEdge) {
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.MAXIMIZED);
      } else if (atLeftEdge && fillsHeight) {
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.LEFT);
      } else if (atRightEdge && fillsHeight) {
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.RIGHT);
      }
   }

   // =========================================================================
   // TILING LOGIC
   // =========================================================================

   _saveOriginalRect(win) {
      const currentState = this._tileState.get(win) || TileState.NONE;
      if (currentState === TileState.NONE && !this._originalRects.has(win)) {
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
      const halfWidth = Math.floor(workArea.width / 2);

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
               width: halfWidth - gap - Math.floor(gap / 2),
               height: workArea.height - gap * 2,
            };

         case TileState.RIGHT:
            return {
               x: workArea.x + halfWidth + Math.floor(gap / 2),
               y: workArea.y + gap,
               width: halfWidth - gap - Math.floor(gap / 2),
               height: workArea.height - gap * 2,
            };

         default:
            return null;
      }
   }

   /**
    * Tile a window to the given state with gaps.
    * After tiling, connects a size-changed signal to aggressively
    * enforce the correct size if the app tries to resize itself.
    */
   _tileWindow(win, state) {
      if (this._processing.has(win)) return;

      const target = this._calculateTileRect(win, state);
      if (!target) return;

      this._processing.add(win);
      this._tileState.set(win, state);
      this._tiledRects.set(win, target);

      // If the window is currently maximized by GNOME, unmaximize first
      const flags = this._getMaximizeFlags(win);
      if (flags !== 0) {
         this._unmaximizeWindow(win, flags);
      }

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
         } catch (e) {
            log(`[Rounded Gaps] Error tiling window: ${e.message}`);
         }

         // Connect aggressive size enforcement after initial tile
         this._addTimeout(100, () => {
            this._connectSizeEnforcement(win);
            this._processing.delete(win);
         });
      });
   }

   /**
    * Connect a size-changed signal on the window. If the window resizes
    * beyond what we set, immediately force it back. This handles apps
    * like Brave, Chrome, etc. that fight the resize.
    */
   _connectSizeEnforcement(win) {
      // Disconnect any existing signal first
      this._disconnectSizeSignal(win);

      const sigId = win.connect("size-changed", () => {
         if (this._processing.has(win)) return;

         const saved = this._tiledRects.get(win);
         if (!saved) return;

         const rect = win.get_frame_rect();

         // If the window deviates from our target by more than 2px, force it back
         const dx = Math.abs(rect.x - saved.x);
         const dy = Math.abs(rect.y - saved.y);
         const dw = Math.abs(rect.width - saved.width);
         const dh = Math.abs(rect.height - saved.height);

         if (dx > 2 || dy > 2 || dw > 2 || dh > 2) {
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
            // Brief lock to prevent signal loop
            this._addTimeout(50, () => {
               this._processing.delete(win);
            });
         }
      });

      this._sizeSignals.set(win, sigId);
   }

   /**
    * Disconnect the size enforcement signal from a window.
    */
   _disconnectSizeSignal(win) {
      const sigId = this._sizeSignals.get(win);
      if (sigId !== undefined) {
         try {
            win.disconnect(sigId);
         } catch (e) {}
         this._sizeSignals.delete(win);
      }
   }

   /**
    * Restore a window to its original size and position.
    */
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
         } catch (e) {
            log(`[Rounded Gaps] Error restoring window: ${e.message}`);
         }
         this._originalRects.delete(win);
      }

      this._addTimeout(300, () => {
         this._processing.delete(win);
      });
   }

   // =========================================================================
   // MUTTER 18 COMPATIBILITY HELPERS
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
   // TOP BAR (TRANSPARENT)
   // =========================================================================

   _enableTopBar() {
      Main.panel.add_style_class_name("transparent-panel");
      Main.panel.set_style(
         "background-color: transparent; border: none; box-shadow: none;"
      );

      // QuickSettingsMenu extends PopupMenu — use open-state-changed
      const qs = Main.panel.statusArea.quickSettings;
      if (qs?.menu) {
         this._quickSettingsSignal = qs.menu.connect(
            "open-state-changed",
            (_menu, open) => {
               if (open) {
                  this._addTimeout(50,  () => this._recolorEverything());
                  this._addTimeout(300, () => this._recolorEverything());
               }
            }
         );
         // Also recolor on first load in case menu was already built
         this._addTimeout(1000, () => this._recolorEverything());
      }
   }

   _disableTopBar() {
      Main.panel.remove_style_class_name("transparent-panel");
      Main.panel.set_style("");

      const qs = Main.panel.statusArea.quickSettings;
      if (qs?.menu && this._quickSettingsSignal) {
         try { qs.menu.disconnect(this._quickSettingsSignal); } catch (e) {}
      }
      this._quickSettingsSignal = null;
   }

   /**
    * Recolor quick-settings popup using the REAL class names from GNOME source:
    *
    *  Arrow/chevron on split tiles  → "quick-toggle-menu-button icon-button"
    *  Slider drawing widget         → "barlevel" (inside "slider" inside "slider-bin")
    *  Slider icon buttons           → "icon-button flat" inside "quick-slider"
    */
   _recolorEverything() {
      try {
         const qs = Main.panel.statusArea.quickSettings;
         if (!qs) return;

         // _grid is the St.Widget with class "quick-settings-grid" — it contains
         // all the tiles and sliders directly. Walking from here reaches barlevel.
         const root = qs.menu._grid ?? qs.menu.box ?? qs.menu.actor ?? qs.menu;

         this._walkActor(root, (actor) => {
            const sc  = actor.get_style_class_name?.() ?? "";
            const psc = actor.get_parent?.()?.get_style_class_name?.() ?? "";

            // Split-tile arrow/chevron — real class: "quick-toggle-menu-button icon-button"
            if (sc.includes("quick-toggle-menu-button")) {
               actor.set_style(
                  "color: #a277ff;" +
                  "background-color: rgba(162,119,255,0.18);" +
                  "border-radius: 0 14px 14px 0;" +
                  "border: none;" +
                  "border-left: 1px solid rgba(162,119,255,0.25);"
               );
            }

            // Icons inside chevron button
            if (psc.includes("quick-toggle-menu-button")) {
               actor.set_style("color: #a277ff;");
            }

            // Separator between tile text and arrow — hide it
            if (sc.includes("quick-toggle-separator")) {
               actor.set_style("background-color: transparent; width: 0;");
            }

            // Bar level fill — real class: "barlevel"
            if (sc.includes("barlevel")) {
               actor.set_style(
                  "-barlevel-background-color: rgba(162,119,255,0.25);" +
                  "-barlevel-active-background-color: #a277ff;" +
                  "-barlevel-overdrive-color: #c9b0ff;"
               );
            }

            // Icon buttons next to sliders — "icon-button flat" inside "quick-slider"
            if (sc.includes("icon-button") && psc.includes("quick-slider")) {
               actor.set_style("color: #a277ff;");
            }
         });

      } catch (e) {
         log(`[Rounded Gaps] _recolorEverything error: ${e.message}`);
      }
   }

   /** Recursively walk actor tree, calling cb on every node */
   _walkActor(actor, cb) {
      if (!actor) return;
      try { cb(actor); } catch (e) {}
      const n = actor.get_n_children?.() ?? 0;
      for (let i = 0; i < n; i++) {
         this._walkActor(actor.get_child_at_index(i), cb);
      }
   }
}
