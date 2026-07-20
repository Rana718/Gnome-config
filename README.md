# Rounded Gaps

A GNOME Shell extension that adds gaps to tiled and maximized windows with
rounded corners — giving GNOME a Hyprland-like look without changing your workflow.

## Features

- Gaps around maximized windows
- Gaps around half-tiled (left/right) windows
- Rounded window corners
- Configurable gap size and corner radius via settings

## Installation

1. Copy the extension folder to `~/.local/share/gnome-shell/extensions/custom-gaps@custom/`
2. Log out and log back in
3. Enable: `gnome-extensions enable custom-gaps@custom`

## Configuration

Adjust settings with:
```bash
# Change gap size (default: 8)
dconf write /org/gnome/shell/extensions/custom-gaps/gap-size 10

# Change corner radius (default: 12)
dconf write /org/gnome/shell/extensions/custom-gaps/corner-radius 16
```

## Compatibility

- GNOME Shell 46, 47, 48, 49, 50
- Wayland and X11

## License

GPL-3.0
