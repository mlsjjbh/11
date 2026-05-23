const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  const headers = createCorsHeaders(new Headers());
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }
  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }
  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url: URL, request: Request): Promise<Response> {
  const apiUrl = new URL(API_BASE_URL);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback") return;
    apiUrl.searchParams.set(key, value);
  });
  if (!apiUrl.searchParams.has("types")) {
    return jsonResponse({ error: "Missing types" }, 400);
  }
  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Accept": "application/json",
    },
  });
  const body = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// ----- Playlist fetching (bypass upstream API which doesn't support types=playlist) -----

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchNeteasePlaylist(id: string): Promise<Response> {
  const resp = await fetch(
    `https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`,
    { headers: { "User-Agent": UA, Referer: "https://music.163.com/" } }
  );
  const json: any = await resp.json();
  if (json.code !== 200 || !json.result) {
    return jsonResponse({ error: "PLAYLIST_NOT_FOUND" }, 404);
  }

  const { name, description, coverImgUrl, trackCount, tracks } = json.result;

  return jsonResponse({
    playlist: { name, description, coverImgUrl, trackCount: trackCount || (tracks || []).length, tracks: tracks || [] },
  }, 200);
}

async function fetchQQPlaylist(id: string): Promise<Response> {
  const resp = await fetch(
    `https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?type=1&id=${encodeURIComponent(id)}&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&g_tk=5381&uin=0`,
    {
      headers: { "User-Agent": UA, Referer: "https://y.qq.com/" },
    }
  );
  const text = await resp.text();
  // QQ API often wraps JSONP-style response, try to extract JSON
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    const match = text.match(/(\{[\s\S]*\})/);
    if (match) json = JSON.parse(match[1]);
    else return jsonResponse({ error: "PLAYLIST_NOT_FOUND" }, 404);
  }

  if (json.code !== 0) return jsonResponse({ error: "PLAYLIST_NOT_FOUND" }, 404);

  const cdlist = json?.data?.cdlist || json?.cdlist || [];
  const playlist = cdlist[0];
  if (!playlist) return jsonResponse({ error: "PLAYLIST_NOT_FOUND" }, 404);

  const songlist = playlist.songlist || [];
  const tracks = songlist.map((song: any) => ({
    id: song.id || song.songmid || "",
    name: song.name || song.title || "",
    ar: (song.singer || song.singers || []).map((s: any) => ({
      id: s.id || "",
      name: typeof s === "string" ? s : (s.name || ""),
    })),
    al: {
      id: song.albumid || song.album_mid || "",
      name: song.albumname || song.album || "",
      picUrl: song.album_pic || song.picurl || "",
    },
    pic_id: song.album_pic || song.pic || song.album_mid || "",
    url_id: song.id || song.songmid || "",
    lyric_id: song.id || song.songmid || "",
  }));

  return jsonResponse({
    playlist: {
      name: playlist.dissname || playlist.title || "",
      description: playlist.desc || "",
      coverImgUrl: playlist.logo || playlist.picurl || playlist.cover || "",
      trackCount: playlist.songnum || songlist.length,
      tracks,
    },
  }, 200);
}

async function fetchKuwoPlaylist(id: string): Promise<Response> {
  const resp = await fetch(
    `https://www.kuwo.cn/api/www/playlist/playListInfo?pid=${encodeURIComponent(id)}`,
    {
      headers: {
        "User-Agent": UA,
        Referer: "https://www.kuwo.cn/",
        csrf: "token",
      },
    }
  );
  const json: any = await resp.json();
  if (json.code !== 200 || !json.data) {
    // Try alternative endpoint
    const resp2 = await fetch(
      `https://www.kuwo.cn/api/www/playlist/playListDetail?pid=${encodeURIComponent(id)}&pn=1&rn=500`,
      {
        headers: { "User-Agent": UA, Referer: "https://www.kuwo.cn/" },
      }
    );
    const json2: any = await resp2.json();
    if (json2.code !== 200 || !json2.data) {
      return jsonResponse({ error: "PLAYLIST_NOT_FOUND" }, 404);
    }
    const data2 = json2.data;
    const musicList = data2.musicList || data2.list || data2.songs || [];
    return jsonResponse({
      playlist: {
        name: data2.name || data2.title || "",
        description: "",
        coverImgUrl: data2.img || data2.pic || data2.cover || data2.image || "",
        trackCount: data2.total || data2.count || musicList.length,
        tracks: musicList.map((s: any) => ({
          id: s.rid || s.id || "",
          name: s.name || s.title || "",
          ar: [{ id: "", name: s.artist || s.author || s.singer || "未知" }],
          al: {
            id: s.albumId || s.aid || "",
            name: s.album || s.albumName || "",
            picUrl: s.albumPic || s.pic || s.image || "",
          },
          pic_id: s.albumPic || s.pic || s.image || "",
          url_id: s.rid || s.id || "",
          lyric_id: s.rid || s.id || "",
        })),
      },
    }, 200);
  }

  const data = json.data;
  const musicList = data.musicList || data.list || [];
  return jsonResponse({
    playlist: {
      name: data.name || data.title || "",
      description: data.desc || "",
      coverImgUrl: data.img || data.pic || data.cover || data.image || "",
      trackCount: data.total || data.count || musicList.length,
      tracks: musicList.map((s: any) => ({
        id: s.rid || s.id || "",
        name: s.name || s.title || "",
        ar: [{ id: "", name: s.artist || s.author || s.singer || "未知" }],
        al: {
          id: s.albumId || s.aid || "",
          name: s.album || s.albumName || "",
          picUrl: s.albumPic || s.pic || s.image || "",
        },
        pic_id: s.albumPic || s.pic || s.image || "",
        url_id: s.rid || s.id || "",
        lyric_id: s.rid || s.id || "",
      })),
    },
  }, 200);
}

async function fetchKugouPlaylist(id: string): Promise<Response> {
  let realId = id;

  // If id looks like a short code (not purely numeric), try to resolve via redirect
  if (!/^\d+$/.test(id)) {
    try {
      const headResp = await fetch(`https://t1.kugou.com/${encodeURIComponent(id)}`, {
        method: "HEAD",
        headers: { "User-Agent": UA },
      });
      const finalUrl = headResp.url || "";
      const match = finalUrl.match(/special\/single\/(\d+)/i);
      if (match) realId = match[1];
    } catch {
      // fall through with original id
    }
  }

  const resp = await fetch(
    `https://mobilecdn.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(realId)}&format=json&from=web`,
    {
      headers: { "User-Agent": UA, Referer: "https://www.kugou.com/" },
    }
  );
  const json: any = await resp.json();
  if (json.status !== 1 || !json.data) {
    return jsonResponse({ error: "PLAYLIST_NOT_FOUND" }, 404);
  }

  const data = json.data;
  const info = data.info || {};
  const songs = data.songs || data.list || [];

  const tracks = songs.map((s: any) => {
    const filename = s.filename || s.name || "";
    const parts = filename.replace(/\.(mp3|flac|wav|aac)$/i, "").split(" - ");
    const artistName = s.singerName || s.author || (parts[0]?.trim()) || "未知";
    const songName = s.songName || s.title || (parts[1]?.trim()) || filename;
    return {
      id: s.hash || s.id || "",
      name: songName,
      ar: [{ id: "", name: artistName }],
      al: {
        id: s.album_id || s.albumId || "",
        name: s.album_name || s.album || "",
        picUrl: s.imgUrl || s.image || "",
      },
      pic_id: s.imgUrl || s.album_img || "",
      url_id: s.hash || s.id || "",
      lyric_id: s.hash || s.id || "",
    };
  });

  return jsonResponse({
    playlist: {
      name: info.specialname || info.name || data.specialname || "",
      description: info.description || info.desc || "",
      coverImgUrl: info.imgurl || info.img || info.cover || data.imgurl || "",
      trackCount: info.total || info.songcount || songs.length,
      tracks,
    },
  }, 200);
}

async function fetchPlaylist(url: URL, request: Request): Promise<Response> {
  const id = url.searchParams.get("id") || "";
  const source = (url.searchParams.get("source") || "netease").toLowerCase();

  if (!id) return jsonResponse({ error: "Missing id" }, 400);

  switch (source) {
    case "netease": return fetchNeteasePlaylist(id);
    case "qq": return fetchQQPlaylist(id);
    case "kuwo": return fetchKuwoPlaylist(id);
    case "kugou": return fetchKugouPlaylist(id);
    default: return jsonResponse({ error: "Unsupported source" }, 400);
  }
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptions();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) return proxyKuwoAudio(target, request);

  const types = url.searchParams.get("types");
  if (types === "playlist") return fetchPlaylist(url, request);

  return proxyApiRequest(url, request);
}
