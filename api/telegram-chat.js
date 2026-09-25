export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CRON_SECRET || request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ error: 'Unauthorized' });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return response.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN' });
  try {
    const result = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      signal: AbortSignal.timeout(10000),
    });
    const body = await result.json();
    if (!result.ok || !body.ok) throw new Error(body.description || 'Telegram request failed');
    const chats = [...new Map((body.result || [])
      .map(update => update.message?.chat || update.edited_message?.chat)
      .filter(Boolean)
      .map(chat => [chat.id, { id: chat.id, type: chat.type, username: chat.username || null }])).values()];
    return response.status(200).json({ chats });
  } catch (error) {
    return response.status(502).json({ error: error.message });
  }
}
