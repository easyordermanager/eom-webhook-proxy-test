/**
 * Cloudflare Worker Proxy for WooCommerce Easy Order Manager Webhooks
 * 
 * SETUP INSTRUCTIONS:
 * 1. Create a KV Namespace named "WEBHOOK_STORAGE"
 * 2. Bind it to this worker with the variable name "WEBHOOK_KV"
 * 3. Add a secret Environment Variable named "AUTH_TOKEN" with your secret password.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // POST /webhook/:courier - Receive webhook from courier
    if (request.method === 'POST' && url.pathname.startsWith('/webhook/')) {
      try {
        const courier = url.pathname.split('/')[2];
        let payloadText = await request.text();
        
        // Ensure payload is not empty
        if (!payloadText) {
          return new Response('Empty payload', { status: 400 });
        }

        // Try to parse JSON for event-specific logic
        let payloadJson = {};
        try {
            payloadJson = JSON.parse(payloadText);
        } catch (e) {}

        const id = crypto.randomUUID();
        const timestamp = Date.now();
        const key = `webhook_${timestamp}_${id}`;
        
        const dataToSave = {
          courier: courier,
          headers: Object.fromEntries(request.headers),
          payload: payloadText,
          received_at: new Date().toISOString()
        };

        // Save to KV
        await env.WEBHOOK_KV.put(key, JSON.stringify(dataToSave));

        // Courier-specific responses
        const responseHeaders = new Headers();
        let responseStatus = 200;
        let responseBodyString = JSON.stringify({ status: 'success', message: 'Webhook received by Cloudflare Proxy.' });

        if (courier === 'pathao') {
            responseStatus = 202;
            const integrationSecret = request.headers.get('x-pathao-signature');
            if (integrationSecret) {
                responseHeaders.set('X-Pathao-Merchant-Webhook-Integration-Secret', integrationSecret);
            }
            if (payloadJson && payloadJson.event === 'webhook_integration') {
                responseBodyString = JSON.stringify({ status: 'success', message: 'Webhook integration successful.' });
            }
        } else if (courier === 'carrybee') {
            if (payloadJson && payloadJson.event === 'webhook.integration') {
                responseStatus = 202;
                responseHeaders.set('X-CB-Webhook-Integration-Header', '40489fe0-9386-4fc9-8e92-2b2fcb9d451c');
                responseBodyString = 'null';
            }
        }

        return new Response(responseBodyString, { 
            status: responseStatus,
            headers: responseHeaders
        });

      } catch (err) {
        return new Response('Error processing webhook: ' + err.message, { status: 500 });
      }
    }

    // GET /fetch - WordPress plugin fetches pending webhooks
    if (request.method === 'GET' && url.pathname === '/fetch') {
      // Authenticate
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        // Fetch up to 50 keys
        const listResult = await env.WEBHOOK_KV.list({ prefix: 'webhook_', limit: 50 });
        
        const webhooks = [];
        const getPromises = listResult.keys.map(async (key) => {
          try {
            const value = await env.WEBHOOK_KV.get(key.name);
            if (value) {
              return { key: key.name, data: JSON.parse(value) };
            }
          } catch (e) {
            // Ignore individual parse/fetch errors
          }
          return null;
        });
        
        const results = await Promise.all(getPromises);
        results.forEach(res => {
          if (res) webhooks.push(res);
        });

        return new Response(JSON.stringify({
          success: true,
          has_more: !listResult.list_complete,
          webhooks: webhooks
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
      }
    }

    // POST /ack - WordPress plugin deletes processed webhooks
    if (request.method === 'POST' && url.pathname === '/ack') {
      // Authenticate
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        const body = await request.json();
        const keysToDelete = body.keys || [];

        // Delete keys concurrently
        const deletePromises = keysToDelete.map(key => env.WEBHOOK_KV.delete(key));
        await Promise.all(deletePromises);

        return new Response(JSON.stringify({ success: true, deleted: keysToDelete.length }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
      }
    }

    // Default 404
    return new Response('Not found', { status: 404 });
  }
};
