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
 * - Forced rounded corners on all NORMAL windows (GLSL shader)
 *
 * License: GPL-3.0
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Meta from "gi://Meta";
import GObject from "gi://GObject";
import Cogl from "gi://Cogl";
import Shell from "gi://Shell";
import Clutter from "gi://Clutter";
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

      // Rounded corners
      this._corneredActors = new Set();
      this._shaderDeclarations = null;
      this._shaderCode = null;
      this._cornerAddedSignal = null;

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
      this._loadShader();

      if (this._getSetting("gaps-enabled", true)) {
         this._enableGaps();
      }

      if (this._getSetting("topbar-enabled", true)) {
         this._enableTopBar();
      }

      if (this._getSetting("corners-enabled", true)) {
         this._enableCorners();
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
      this._settingsConnections.push(
         this._settings.connect("changed::corners-enabled", () => {
            if (this._settings.get_boolean("corners-enabled"))
               this._enableCorners();
            else this._disableCorners();
         }),
      );
      this._settingsConnections.push(
         this._settings.connect("changed::corner-radius", () => {
            if (this._getSetting("corners-enabled", true)) {
               this._disableCorners();
               this._enableCorners();
            }
         }),
      );
   }

   disable() {
      this._disableGaps();
      this._disableTopBar();
      this._disableCorners();

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
   // SHADER LOADING
   // =========================================================================

   _loadShader() {
      try {
         const shaderFile = Gio.File.new_for_path(
            `${this.path}/shader/rounded_corners.frag`,
         );
         const [ok, contents] = shaderFile.load_contents(null);
         if (!ok) return;

         const shaderSource = new TextDecoder().decode(contents);

         // Split shader into declarations (uniforms, functions before main)
         // and the body of main() for add_glsl_snippet
         const mainMatch = shaderSource.match(/void\s+main\s*\(\s*\)\s*\{/);
         if (!mainMatch) return;

         const mainIdx = mainMatch.index;
         this._shaderDeclarations = shaderSource.substring(0, mainIdx).trim();

         // Extract body between the braces of main()
         const afterMain = shaderSource.substring(
            mainIdx + mainMatch[0].length,
         );
         // Find matching closing brace (simple: last '}')
         const lastBrace = afterMain.lastIndexOf("}");
         this._shaderCode = afterMain.substring(0, lastBrace).trim();
      } catch (e) {
         log(`[Rounded Gaps] Failed to load shader: ${e.message}`);
         this._shaderDeclarations = null;
         this._shaderCode = null;
      }
   }

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

      // --- Step 4b: Apply gaps to already maximized/tiled windows ---
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

      // --- Step 5: Detect edge drags via grab-op-end ---
      this._connectSignal(global.display, "grab-op-end", (display, window) => {
         if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
         if (this._processing.has(window)) return;

         // Small delay to let the grab settle
         const id = this._addTimeout(50, () => {
            this._detectEdgeDrag(window);
         });
      });

      // --- Step 6: Track window destruction + apply gaps to newly created maximized windows ---
      this._connectSignal(
         global.display,
         "window-created",
         (display, window) => {
            if (window && window.get_window_type() === Meta.WindowType.NORMAL) {
               const unmId = window.connect("unmanaged", () => {
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
                     // Half-tiled - detect left or right
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

      // --- Step 6: On focus change, snap back windows that grew (Chrome/Brave fix) ---
      this._connectSignal(global.display, "notify::focus-window", () => {
         const win = global.display.focus_window;
         if (!win || this._processing.has(win)) return;

         const saved = this._tiledRects.get(win);
         if (!saved) return;

         // Check if window grew beyond saved size
         const rect = win.get_frame_rect();
         if (rect.width > saved.width + 3 || rect.height > saved.height + 3) {
            win.move_frame(true, saved.x, saved.y);
            win.move_resize_frame(
               true,
               saved.x,
               saved.y,
               saved.width,
               saved.height,
            );
         }
      });
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
         // Restore to original size
         this._restoreWindow(win);
      } else {
         // Already restored, minimize
         win.minimize();
      }
   }

   // =========================================================================
   // EDGE DRAG DETECTION
   // =========================================================================

   _detectEdgeDrag(win) {
      const rect = win.get_frame_rect();
      const workArea = win.get_work_area_current_monitor();

      // Threshold in pixels for detecting edge proximity
      const threshold = 5;

      const atLeftEdge = Math.abs(rect.x - workArea.x) < threshold;
      const atRightEdge =
         Math.abs(rect.x + rect.width - (workArea.x + workArea.width)) <
         threshold;
      const atTopEdge = Math.abs(rect.y - workArea.y) < threshold;

      // Check if window was dragged to fill a significant portion (like GNOME's snap)
      const fillsHeight = rect.height >= workArea.height - threshold * 2;

      if (atTopEdge && !atLeftEdge && !atRightEdge) {
         // Dragged to top edge => maximize with gaps
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.MAXIMIZED);
      } else if (atLeftEdge && fillsHeight) {
         // Dragged to left edge => tile left
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.LEFT);
      } else if (atRightEdge && fillsHeight) {
         // Dragged to right edge => tile right
         this._saveOriginalRect(win);
         this._tileWindow(win, TileState.RIGHT);
      }
   }

   // =========================================================================
   // TILING LOGIC
   // =========================================================================

   /**
    * Save the window's current frame rect as its "original" position,
    * but only if it's not already tiled by us.
    */
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

   /**
    * Calculate the target rectangle for a given tile state.
    */
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
    * Uses the WinTile/gTile approach: unmaximize first if needed,
    * then move_frame + move_resize_frame.
    */
   _tileWindow(win, state) {
      if (this._processing.has(win)) return;

      const target = this._calculateTileRect(win, state);
      if (!target) return;

      this._processing.add(win);
      this._tileState.set(win, state);
      this._tiledRects.set(win, target); // Save target for focus-snap

      // If the window is currently maximized by GNOME, unmaximize first
      const flags = this._getMaximizeFlags(win);
      if (flags !== 0) {
         this._unmaximizeWindow(win, flags);
      }

      // Use WinTile approach: move_frame first, then move_resize_frame
      // A small delay ensures GNOME's unmaximize animation completes
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

         // Keep processing lock briefly to prevent re-entry
         this._addTimeout(300, () => {
            this._processing.delete(win);
         });
      });
   }

   /**
    * Restore a window to its original size and position.
    */
   _restoreWindow(win) {
      if (this._processing.has(win)) return;

      const original = this._originalRects.get(win);
      this._tileState.set(win, TileState.NONE);
      this._tiledRects.delete(win);
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

   /**
    * Get maximize flags - Mutter 18 uses get_maximize_flags(),
    * older versions use get_maximized().
    */
   _getMaximizeFlags(win) {
      if (win.get_maximize_flags) return win.get_maximize_flags();
      if (win.get_maximized) return win.get_maximized();
      return 0;
   }

   /**
    * Unmaximize window - Mutter 18 uses set_unmaximize_flags(flags)
    * then unmaximize() with no args. Older versions use unmaximize(flags).
    */
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
   // ROUNDED CORNERS (GLSL SHADER EFFECT)
   // =========================================================================

   _enableCorners() {
      if (!this._shaderDeclarations || !this._shaderCode) return;

      const radius = this._getSetting("corner-radius", 12);

      // Set static properties on the effect class
      RoundedCornersEffect._shaderDeclarations = this._shaderDeclarations;
      RoundedCornersEffect._shaderCode = this._shaderCode;
      RoundedCornersEffect._radius = radius;

      // Apply to existing windows
      for (const actor of global.get_window_actors()) {
         this._applyCornerEffect(actor);
      }

      // Apply to new windows when added to window_group
      this._cornerAddedSignal = global.window_group.connect(
         "child-added",
         (_group, actor) => {
            this._addTimeout(100, () => {
               this._applyCornerEffect(actor);
            });
         },
      );
   }

   _disableCorners() {
      if (this._cornerAddedSignal) {
         global.window_group.disconnect(this._cornerAddedSignal);
         this._cornerAddedSignal = null;
      }

      for (const actor of this._corneredActors) {
         try {
            const effect = actor.get_effect("rounded-gaps-corners");
            if (effect) actor.remove_effect(effect);
         } catch (e) {}
      }
      this._corneredActors.clear();
   }

   _applyCornerEffect(actor) {
      if (!actor || !this._shaderDeclarations || !this._shaderCode) return;

      // Only apply to NORMAL application windows
      if (!actor.meta_window) return;
      if (actor.meta_window.get_window_type() !== Meta.WindowType.NORMAL)
         return;

      // Skip if already applied
      if (actor.get_effect("rounded-gaps-corners")) return;

      try {
         const effect = new RoundedCornersEffect();
         actor.add_effect_with_name("rounded-gaps-corners", effect);
         this._corneredActors.add(actor);
      } catch (e) {
         log(`[Rounded Gaps] Failed to apply corner effect: ${e.message}`);
      }
   }

   // =========================================================================
   // TOP BAR (TRANSPARENT)
   // =========================================================================

   _enableTopBar() {
      Main.panel.add_style_class_name("transparent-panel");
      Main.panel.set_style("background-color: transparent;");
   }

   _disableTopBar() {
      Main.panel.remove_style_class_name("transparent-panel");
      Main.panel.set_style("");
   }
}

// =============================================================================
// ROUNDED CORNERS GLSL EFFECT
// =============================================================================

const RoundedCornersEffect = GObject.registerClass(
   {},
   class RoundedCornersEffect extends Shell.GLSLEffect {
      // Static properties set by the extension before instantiation
      static _shaderDeclarations = "";
      static _shaderCode = "";
      static _radius = 12;

      _init() {
         super._init();
         this._uBounds = this.get_uniform_location("bounds");
         this._uClipRadius = this.get_uniform_location("clipRadius");
         this._uPixelStep = this.get_uniform_location("pixelStep");
      }

      vfunc_build_pipeline() {
         this.add_glsl_snippet(
            Cogl.SnippetHook.FRAGMENT,
            RoundedCornersEffect._shaderDeclarations,
            RoundedCornersEffect._shaderCode,
            false,
         );
      }

      vfunc_paint_target(node, paintContext) {
         const actor = this.get_actor();
         if (actor && actor.meta_window) {
            const actorWidth = actor.get_width();
            const actorHeight = actor.get_height();

            if (actorWidth > 0 && actorHeight > 0) {
               this.set_uniform_float(this._uBounds, 4, [
                  0,
                  0,
                  actorWidth,
                  actorHeight,
               ]);
               this.set_uniform_float(this._uClipRadius, 1, [
                  RoundedCornersEffect._radius,
               ]);
               this.set_uniform_float(this._uPixelStep, 2, [
                  1.0 / actorWidth,
                  1.0 / actorHeight,
               ]);
            }
         }
         super.vfunc_paint_target(node, paintContext);
      }
   },
);
