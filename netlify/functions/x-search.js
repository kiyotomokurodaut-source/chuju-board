// X(Twitter) API v2 の「直近ツイート検索」をサーバー側だけで呼び出すプロキシ。
// Bearer Tokenはこのファイルには書かず、Netlifyの環境変数 X_BEARER_TOKEN から読む。
// フロントエンド(ブラウザ)には絶対にトークンを渡さない設計。
//
// 呼び出し例: /.netlify/functions/x-search?q=%232027年組&max=10

const CACHE = new Map(); // {key: {at, data}} 簡易キャッシュ(同一インスタンス内・数分程度のみ有効)
const CACHE_MS = 3 * 60 * 1000;

exports.handler = async (event) => {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    return json(500, { error: "サーバー側にX_BEARER_TOKENが設定されていません(Netlifyの環境変数を確認してください)" });
  }

  const q = (event.queryStringParameters || {}).q;
  if (!q || q.length > 200) {
    return json(400, { error: "検索クエリ(q)が必要です" });
  }
  const max = Math.min(Math.max(Number((event.queryStringParameters || {}).max) || 10, 5), 20);

  const cacheKey = q + "|" + max;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return json(200, cached.data, true);
  }

  const url = new URL("https://api.twitter.com/2/tweets/search/recent");
  url.searchParams.set("query", q);
  url.searchParams.set("max_results", String(max));
  url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name,profile_image_url");

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status === 429) {
      return json(429, { error: "レート制限に達しました。しばらく待ってから再度お試しください。" });
    }
    if (res.status === 403 || res.status === 401) {
      const body = await res.text();
      return json(res.status, {
        error: "X APIへのアクセスが拒否されました。現在のAPIプランでは検索エンドポイントが利用できない可能性があります(無料プランは検索非対応です)。",
        detail: body.slice(0, 300)
      });
    }
    if (!res.ok) {
      const body = await res.text();
      return json(res.status, { error: "X APIエラー", detail: body.slice(0, 300) });
    }

    const data = await res.json();
    const users = {};
    for (const u of (data.includes && data.includes.users) || []) users[u.id] = u;

    const tweets = (data.data || []).map(t => {
      const u = users[t.author_id] || {};
      return {
        id: t.id,
        text: t.text,
        createdAt: t.created_at,
        likeCount: t.public_metrics ? t.public_metrics.like_count : null,
        author: { name: u.name || "", username: u.username || "", avatar: u.profile_image_url || "" },
        url: u.username ? `https://twitter.com/${u.username}/status/${t.id}` : `https://twitter.com/i/web/status/${t.id}`
      };
    });

    const result = { tweets, fetchedAt: new Date().toISOString(), count: tweets.length };
    CACHE.set(cacheKey, { at: Date.now(), data: result });
    return json(200, result);
  } catch (e) {
    return json(500, { error: "取得に失敗しました", detail: String(e && e.message || e) });
  }
};

function json(status, body, cacheHit) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "x-cache": cacheHit ? "HIT" : "MISS" },
    body: JSON.stringify(body)
  };
}
