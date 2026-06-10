module.exports = async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_DATABASE_ID;

  if (!token || !dbId) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // Step 1: try with 公開 filter + created_time sort
  // Step 2: if 400 (property not found), retry without filter
  async function query(withFilter) {
    const body = {
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 6,
    };
    if (withFilter) {
      body.filter = { property: '公開', checkbox: { equals: true } };
    }
    return fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  // Look at the page body and return the URL of the first image block
  async function findFirstImage(pageId) {
    try {
      const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
        headers,
      });
      if (!r.ok) return null;
      const data = await r.json();
      for (const block of data.results || []) {
        if (block.type === 'image') {
          const img = block.image;
          return img?.file?.url || img?.external?.url || null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  try {
    let r = await query(true);

    // If filter caused 400, retry without it
    if (r.status === 400) {
      r = await query(false);
    }

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }

    const data = await r.json();

    const posts = await Promise.all(data.results.map(async page => {
      const p = page.properties;

      // title: find the property of type 'title'
      const titleProp = Object.values(p).find(v => v.type === 'title');
      const title = titleProp?.title?.map(t => t.plain_text).join('') || '無題';

      // date: try common Japanese/English property names
      const dateProp = p['日付'] || p['Date'] || p['date'] || p['公開日'] || p['作成日'];
      const date = dateProp?.date?.start || page.created_time?.slice(0, 10) || null;

      // excerpt: try common property names
      const excerptProp = p['内容'] || p['説明'] || p['概要'] || p['Description'] || p['excerpt'] || p['本文'];
      const excerpt = excerptProp?.rich_text?.map(t => t.plain_text).join('').slice(0, 100) || '';

      // thumbnail: page cover image, falling back to the first image in the page body
      const cover = page.cover;
      const coverUrl = cover?.external?.url || cover?.file?.url || null;
      const thumbnail = coverUrl || await findFirstImage(page.id);

      // url to Notion page
      const url = `https://www.notion.so/${page.id.replace(/-/g, '')}`;

      return { id: page.id, title, date, excerpt, thumbnail, url };
    }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ posts });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
