# Build resources

electron-builder reads icons from this directory
(`directories.buildResources` in `electron-builder.config.cjs`).

## App icon (v1.0.0 brand mark)

| File | Use |
| --- | --- |
| `logo-source.png` | Original brand artwork |
| `icon.png` | 1024×1024 master / Linux |
| `icon.icns` | macOS |
| `icon.ico` | Windows |

Regenerate from `logo-source.png` with `sips` + `iconutil` + `png-to-ico` if the
artwork changes.
