# Third-Party Notices

This project bundles or depends on the following third-party software. Each remains under its own license, listed below.

## Bundled in this repository

| Component | License | Notes |
|---|---|---|
| [Leaflet](https://leafletjs.com/) 1.9.4 | BSD-2-Clause | Bundled locally in `assets/leaflet/`. Copyright notice preserved in the minified file. |
| [Golos Text](https://github.com/googlefonts/golos-text) font | SIL Open Font License 1.1 | Bundled locally in `assets/fonts/`. Full license text: `assets/fonts/OFL-golos-text.txt`. The OFL permits embedding and redistribution but the font may not be sold on its own. |
| OpenStreetMap map tiles | [ODbL](https://opendatacommons.org/licenses/odbl/) (data) + [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) | Tiles are fetched live from `tile.openstreetmap.org`, not redistributed. Attribution ("© OpenStreetMap contributors") is shown on the map as required. **Important:** the public OSM tile server is meant for light, personal use on donated infrastructure — see "Scaling" note below if this project gets real traction. |

## npm dependencies (installed via `npm install`, not committed to the repo)

| Package | License |
|---|---|
| [electron](https://www.npmjs.com/package/electron) | MIT |
| [electron-builder](https://www.npmjs.com/package/electron-builder) | MIT |
| [electron-store](https://www.npmjs.com/package/electron-store) | MIT |
| [electron-updater](https://www.npmjs.com/package/electron-updater) | MIT |

All of the above are permissive licenses (MIT / BSD / Apache-2.0) and do not require this project to be released under a matching or copyleft license. The OFL on the font is the only one with a redistribution condition (don't sell the font by itself), which does not restrict this app.

## AI provider

This app does not include or bundle any AI model. At runtime it calls the [Google Gemini API](https://ai.google.dev/) (`generativelanguage.googleapis.com`) directly using an API key that **each user provides themselves** via Google AI Studio (see "Privacy" in the README). By using this app, you agree to comply with [Google's Gemini API Terms of Service](https://ai.google.dev/gemini-api/terms) and the terms of whichever underlying model you select, independently of this project.

## Scaling beyond personal use

If this app is used by many people at once, please consider:
- Moving off the raw `tile.openstreetmap.org` endpoint to a dedicated provider (e.g. MapTiler, Stadia Maps, Mapbox) that's built for production traffic — OSM's own tile servers explicitly ask heavy users to do this.
- Not the AI side of this — that one already scales fine, since every user supplies their own Google AI Studio key and quota.
