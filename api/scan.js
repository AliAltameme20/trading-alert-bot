import { runScan } from '../lib/scan.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CRON_SECRET || request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runScan();
    return response.status(200).json(result);
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
}
