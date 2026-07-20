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
        topbarInfoGroup.add(cssPathRow);
    }
}
