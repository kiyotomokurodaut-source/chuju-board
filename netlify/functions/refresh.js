// 手動更新ボタン用のプロキシ。APIキーをブラウザに出さずにAnthropic APIを呼ぶ。
// 環境変数: ANTHROPIC_API_KEY(必須) / REFRESH_TOKEN(任意: 設定するとヘッダ照合)
exports.handler = async (event) => {
  const { name, pref } = event.queryStringParameters || {};
  if (!name || name.length > 40) return { statusCode: 400, body: JSON.stringify({ error: "name is required" }) };
  if (process.env.REFRESH_TOKEN && event.headers["x-refresh-token"] !== process.env.REFRESH_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }
  const prompt = `「${name}」(${pref || "首都圏"}の中学校)について、web検索で学校公式サイトと各塾の公式サイトを中心に調べ、次のJSONだけを返してください。前置き・説明・コードフェンスは一切禁止。確認できない項目は空配列に。各要素には必ず実在の出典URL(source)を含め、出典が確認できない情報は含めないこと。
{"exams":[{"date":"YYYY-MM-DD","slot":"AM|PM","name":"回の名称","note":"科目・方式など","source":"URL"}],"sessions":[{"date":"YYYY-MM-DD","name":"説明会・行事名","note":"予約方法など","source":"URL"}],"preferences":[{"desc":"優遇・特待などの制度","source":"URL"}],"juku":[{"name":"塾名","count":合格者数の数値,"year":"2026","source":"URL"}],"dev":{"scale":"四谷大塚80偏差値など模試名","value":数値,"source":"URL"},"notes":"補足や不明点"}
対象: 2027年度入試の日程・方式、2026年開催予定の説明会、塾別合格者数は2026年入試の公表値。各配列は最大6件。簡潔に。`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in response");
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: m[0] };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
