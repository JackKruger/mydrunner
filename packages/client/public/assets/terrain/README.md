# Terrain material maps

Seven compact, text-based 256 px SVG material sets. Each albedo, tangent-space normal, and roughness map uses a periodic SVG pattern on both axes and repeats without seams. Filenames are `<surface>-<channel>.svg`. Keeping the assets as SVG makes the library compatible with source-review systems that reject binary files; HTTP compression reduces the text further in production.

The renderer uses the additional `normal-roughness` maps (normal XYZ, roughness in opacity) to remain within WebGL texture-unit limits. Separate normal and roughness source maps are retained for inspection and future asset-pipeline work.
