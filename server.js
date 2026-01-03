const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();

// 1. DEFAULT TO 8080 (Standard for New Railway Apps)
const PORT = process.env.PORT || 8080;

const agent = new https.Agent({ keepAlive: true, timeout: 600000 });
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const MODEL_MAPPING = {
  'gpt-4o': 'z-ai/glm4.7',
  'glm-4': 'z-ai/glm4.7',
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-3.5-turbo': 'moonshotai/kimi-k2-thinking',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'kimi-k2-thinking': 'moonshotai/kimi-k2-thinking'
};

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.options('*', cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// 2. HEALTH CHECK (Prevents the SIGTERM crash)
app.get('/', (req, res) => res.status(200).send('Proxy Running!'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/v1/chat/completions', async (req, res) => {
  try {
    let nimRequest = { ...req.body };
    const requestedModel = nimRequest.model;
    nimRequest.model = MODEL_MAPPING[requestedModel] || requestedModel;

    nimRequest.extra_body = { ...nimRequest.extra_body, chat_template_kwargs: { thinking: true } };
    if (!nimRequest.max_tokens) nimRequest.max_tokens = 4096;

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: nimRequest.stream ? 'stream' : 'json',
      httpsAgent: agent,
      timeout: 600000
    });

    if (nimRequest.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 10000);
      
      response.data.on('data', chunk => {
        if (!chunk.toString().includes('[DONE]')) res.write(chunk);
      });
      response.data.on('end', () => { clearInterval(heartbeat); res.end(); });
      response.data.on('error', () => { clearInterval(heartbeat); res.end(); });
    } else {
      res.json(response.data);
    }
  } catch (error) {
    res.status(500).json({ error: "Proxy Error" });
  }
});

// 3. LISTEN ON 0.0.0.0 (Crucial for Railway)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
});
```

---

### Step 2: The Railway Reset (Do this carefully)
Go to your **Railway Project** (on Firefox/Browser) and change these settings to match the code above.

1.  **Variables Tab:**
    *   **Delete** the `PORT` variable if you added it earlier.
    *   Leave only `NIM_API_KEY`.

2.  **Settings Tab -> Networking:**
    *   **Service Port:** Set to **`8080`**.
    *   *(Note: Even if it already says 8080, delete it and type it again to be sure).*

3.  **Settings Tab -> Service (or Deploy):**
    *   **Healthcheck Path:** **DELETE IT.** Make it completely blank/empty.
    *   *(This stops Railway from killing the app if it takes 1 second too long to reply).*

**Click Redeploy.**

This forces your app to use the standard **Port 8080** configuration, which is what works on 99% of new Railway accounts.
32.6s
info
Google AI models may make mistakes, so double-check outputs.
Use Arrow Up and Arrow Down to select a turn, Enter to jump to it, and Escape to return to the chat.
Start typing a prompt
