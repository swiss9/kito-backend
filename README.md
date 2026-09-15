# KITO Backend

API for [kito-search.vercel.app](https://kito-search.vercel.app). Anime and tokusatsu search, release ranking, and recommendations.

**Stack:** Node.js, Express, Vercel. Metadata from MyAnimeList, Kitsu, TMDB. Torrents from Nyaa and TorrentClaw. Recommendations via Groq.

**Endpoints:**
- `GET /api/search` — search titles
- `GET /api/releases` — ranked releases for a media ID
- `POST /api/releases/batch` — releases for multiple IDs
- `POST /api/recommendations` — personalized picks from bookmarks
- `GET /api/recommended` — curated handpicked list
- `GET /api/health` — upstream status
- `DELETE /api/admin/cache` — clear cache (admin token required)

© 2026 KITO. All rights reserved.
