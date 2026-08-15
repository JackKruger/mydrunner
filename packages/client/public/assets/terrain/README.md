# Terrain material maps

Seven terrain material sets. Each surface uses a generated 1024 px PNG albedo. The original compact, text-based 256 px SVG albedos remain alongside them as lightweight fallback/reference assets. Normal and roughness filenames follow `<surface>-<channel>.svg`.

The renderer uses the additional `normal-roughness` maps (normal XYZ, roughness in opacity) to remain within WebGL texture-unit limits. Separate normal and roughness source maps are retained for inspection and future asset-pipeline work.
