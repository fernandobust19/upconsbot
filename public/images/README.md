Guía rápida para imágenes (rendimiento y nombres)

Dónde ponerlas
- Coloca todos los archivos de imagen aquí: `public/images/`.
- Se sirven automáticamente desde `/images/...` (Ej.: `/images/teja-espanola.webp`).

Nombres de archivo
- Usa minúsculas y guiones: `teja-espanola.webp` (evita tildes y ñ en el nombre del archivo, usa `espanola`).
- Sé descriptivo y breve: `tubo-cuadrado-100x100-2mm.webp`.
- Si hay variantes, añade sufijos: `...-naranja.webp`, `...-blanco.webp`.

Formatos recomendados (rápidos)
- Preferido: WebP (`.webp`) calidad 70–80.
- Alternativas: JPEG (`.jpg/.jpeg`) si no puedes exportar WebP.
- Transparencia: PNG solo cuando sea necesaria (logos, íconos con transparencia).
- Íconos/diagramas simples: SVG.

Tamaños sugeridos (para no ser lento)
- Chat/miniatura: ancho 640 px (≤ 120 KB).
- Vista detallada/página: ancho 1280 px (≤ 250 KB).
- Si generas dos tamaños, nómbralos con sufijo: `teja-espanola-640.webp`, `teja-espanola-1280.webp`.

Optimización (tips)
- Comprime (WebP q=70–80). Remueve metadatos EXIF.
- No subas fotos 4000 px si se mostrarán pequeñas; redimensiona antes.
- Mantén cada imagen idealmente < 250 KB (miniaturas < 120 KB).

Primeras imágenes sugeridas
- Teja española (naranja, blanco, terracota): `teja-espanola-naranja-640.webp`, `teja-espanola-naranja-1280.webp`.

Cómo referenciarlas
- En HTML/JS: `<img src="/images/teja-espanola-640.webp" alt="Teja española color naranja" />`.
- Para fallback JPEG (opcional):
  <picture>
    <source srcset="/images/teja-espanola-640.webp" type="image/webp">
    <img src="/images/teja-espanola-640.jpg" alt="Teja española color naranja">
  </picture>

