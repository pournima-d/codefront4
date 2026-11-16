# Roadmap — BATON

Realistic post-Round-3 engineering priorities:

1. **Automated Raster OCR Worker (`NEEDS_OCR` Queue)**: Add an optional server-side OCR adapter (e.g., Tesseract worker container) to convert scanned PDF notebooks marked `NEEDS_OCR` into searchable source spans without requiring manual transcription.
2. **Signed PDF & Checksummed Bundle Export**: Export published handover packages as deterministically formatted PDFs with an accompanying SHA-256 manifest verifying included record versions and redaction overlays.
3. **Database Externalization Adapter**: Add an optional PostgreSQL storage driver alongside the zero-config SQLite (`better-sqlite3`) driver for multi-replica enterprise laboratory deployments.
4. **Automated Headless Browser E2E Suite**: Add Playwright verification across desktop and mobile viewports (dark-mode accessibility contrast, drag-and-drop uploads, keyboard navigation, and Notes Studio rich-text editing).
5. **Read-Only ELN & Git Tag Connectors**: Signed webhook/polling adapters to ingest frozen lab notebook snapshots and dataset checksums directly into `Files & Vault`.
