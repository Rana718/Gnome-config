/**
 * Rounded Gaps - Preferences UI
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class RoundedGapsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ===================== GAPS PAGE =====================
        const gapsPage = new Adw.PreferencesPage({
            title: 'Window Gaps',
            icon_name: 'view-grid-symbolic',
        });
        window.add(gapsPage);

        const gapsEnableGroup = new Adw.PreferencesGroup({
            title: 'Window Gaps',
            description: 'Add Hyprland-style gaps around tiled and maximized windows',
        });
        gapsPage.add(gapsEnableGroup);

        const gapsEnabledRow = new Adw.SwitchRow({
            title: 'Enable Window Gaps',
            subtitle: 'Add gaps around maximized and tiled windows',
        });
        settings.bind('gaps-enabled', gapsEnabledRow, 'active', 0);
        gapsEnableGroup.add(gapsEnabledRow);

        const gapsSettingsGroup = new Adw.PreferencesGroup({
            title: 'Gap Settings',
        });
        gapsPage.add(gapsSettingsGroup);

        const gapSizeRow = new Adw.SpinRow({
            title: 'Gap Size',
            subtitle: 'Size of gaps in pixels (0–64)',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 64,
                step_increment: 1,
                page_increment: 4,
                value: settings.get_int('gap-size'),
            }),
        });
        settings.bind('gap-size', gapSizeRow, 'value', 0);
        gapsSettingsGroup.add(gapSizeRow);

        const animDelayRow = new Adw.SpinRow({
            title: 'Animation Delay',
            subtitle: 'Wait time (ms) for tiling animation to finish before applying gaps',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 1000,
                step_increment: 25,
                page_increment: 100,
                value: settings.get_int('animation-delay'),
            }),
        });
        settings.bind('animation-delay', animDelayRow, 'value', 0);
        gapsSettingsGroup.add(animDelayRow);

        // ===================== CORNERS PAGE =====================
        const cornersPage = new Adw.PreferencesPage({
            title: 'Corners',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(cornersPage);

        const cornersEnableGroup = new Adw.PreferencesGroup({
            title: 'Rounded Corners',
            description: 'Force rounded corners on ALL windows (Chrome, Firefox, etc.)',
        });
        cornersPage.add(cornersEnableGroup);

        const cornersEnabledRow = new Adw.SwitchRow({
            title: 'Enable Rounded Corners',
            subtitle: 'Apply rounded corners to all application windows',
        });
        settings.bind('corners-enabled', cornersEnabledRow, 'active', 0);
        cornersEnableGroup.add(cornersEnabledRow);

        const cornersSettingsGroup = new Adw.PreferencesGroup({
            title: 'Corner Settings',
        });
        cornersPage.add(cornersSettingsGroup);

        const cornerRadiusRow = new Adw.SpinRow({
            title: 'Corner Radius',
            subtitle: 'Roundness of window corners (0–32px)',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 32,
                step_increment: 1,
                page_increment: 4,
                value: settings.get_int('corner-radius'),
            }),
        });
        settings.bind('corner-radius', cornerRadiusRow, 'value', 0);
        cornersSettingsGroup.add(cornerRadiusRow);

        // ===================== TOP BAR PAGE =====================
        const topbarPage = new Adw.PreferencesPage({
            title: 'Top Bar',
            icon_name: 'open-menu-symbolic',
        });
        window.add(topbarPage);

        const topbarEnableGroup = new Adw.PreferencesGroup({
            title: 'Transparent Top Bar',
            description: 'Transparent panel with pill-shaped indicator buttons',
        });
        topbarPage.add(topbarEnableGroup);

        const topbarEnabledRow = new Adw.SwitchRow({
            title: 'Enable Transparent Top Bar',
            subtitle: 'Make the panel transparent with pill-shaped buttons',
        });
        settings.bind('topbar-enabled', topbarEnabledRow, 'active', 0);
        topbarEnableGroup.add(topbarEnabledRow);

        const topbarInfoGroup = new Adw.PreferencesGroup({
            title: 'Customization',
            description: 'Edit the stylesheet.css file in the extension folder to customize colors, border-radius, padding, etc.',
        });
        topbarPage.add(topbarInfoGroup);

        const cssPathRow = new Adw.ActionRow({
            title: 'Stylesheet Location',
            subtitle: `${this.path}/stylesheet.css`,
        });

        const openButton = new Gtk.Button({
            label: 'Open CSS File',
            valign: Gtk.Align.CENTER,
        });
        openButton.connect('clicked', () => {
            const file = Gtk.gio.File.new_for_path(`${this.path}/stylesheet.css`);
            try {
                Gtk.show_uri(window, `file://${this.path}/stylesheet.css`, 0);
            } catch (e) {
                // Fallback - just show the path
            }
        });
        cssPathRow.add_suffix(openButton);
        topbarInfoGroup.add(cssPathRow);
    }
}
