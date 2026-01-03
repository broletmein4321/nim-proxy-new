const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;

// ==============================================================================
// 1. CONFIGURATION
// ==============================================================================

const agent = new https.Agent({ keepAlive: true, timeout: 600000 });
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const MODEL_MAPPING = {
  // New GLM Model
  'gpt-4o': 'z-ai/glm4.7',
  'glm-4': 'z-ai/glm4.7',
  // Old Models
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-3.5-turbo': 'moonshotai/kimi-k2-thinking',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'kimi-k2-thinking': 'moonshotai/kimi-k2-thinking'
};

// ==============================================================================
// 2. MIDDLEWARE
// ==============================================================================

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.options('*', cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// ==============================================================================
// 3. HEALTH CHECK (Prevents SIGTERM)
// ==============================================================================
app.get('/', (req, res) => res.status(200).send('Proxy is Alive!'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/v1/models', (req, res) => res.json({ object: 'list', data: [] }));

// ==============================================================================
// 4. PROXY LOGIC
// ==============================================================================

app.post('/v1/chat/completions', async (req, res) => {
  try {
    let nimRequest = { ...req.body };
    const requestedModel = nimRequest.model;
    nimRequest.model = MODEL_MAPPING[requestedModel] || requestedModel;

    nimRequest.extra_body = { ...nimRequest.extra_body, chat_template_kwargs: { thinking: true } };
    if (!nimRequest.max_tokens || nimRequest.max_tokens < 512) nimRequest.max_tokens = 4096;

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: nimRequest.stream ? 'stream' : 'json',
      httpsAgent: agent,
      timeout: 600000
    });

    if (nimRequest.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 10000);
      
      response.data.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
           if (line.includes('[DONE]')) { clearInterval(heartbeat); res.write('data: [DONE]\n\n'); continue; }
           // Simple pass-through to ensure stability
           if (line.startsWith('data: ')) res.write(line + '\n');
        }
      });
      response.data.on('end', () => { clearInterval(heartbeat); res.end(); });
      response.data.on('error', () => { clearInterval(heartbeat); res.end(); });
    } else {
      res.json(response.data);
    }
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Proxy Error" });
  }
});

// 🔥 THE FIX: Bind to 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy running on port ${PORT}`);
});
