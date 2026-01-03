const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();

// 1. TRUST RAILWAY'S PORT
// Do not force 8080. Let Railway tell us what port to use.
const PORT = process.env.PORT || 3000;

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

// 2. THE SIMPLEST HEALTH CHECK
// This prevents the SIGTERM crash.
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/v1/models', (req, res) => res.json({ object: 'list', data: [] }));

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
  }const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();

// Use the port Railway gives us, or 8080 as backup
const PORT = process.env.PORT || 8080;

// ==============================================================================
// 1. CONFIGURATION
// ==============================================================================

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

// ==============================================================================
// 2. MIDDLEWARE
// ==============================================================================

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.options('*', cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// ==============================================================================
// 3. ROBUST HEALTH CHECK (The Anti-Crash Fix)
// ==============================================================================

// Log when the health check is hit so we know Railway sees us
app.get('/', (req, res) => {
  console.log('✅ Health Check Ping received on /');
  res.status(200).send('Proxy is Alive!');
});

app.get('/health', (req, res) => {
  console.log('✅ Health Check Ping received on /health');
  res.json({ status: 'ok' });
});

// Helper for clients
app.get('/v1/models', (req, res) => {
  res.json({ object: 'list', data: Object.keys(MODEL_MAPPING).map(id => ({ id, object: 'model' })) });
});

// ==============================================================================
// 4. MAIN PROXY
// ==============================================================================

app.post('/v1/chat/completions', async (req, res) => {
  try {
    let nimRequest = { ...req.body };
    const requestedModel = nimRequest.model;
    nimRequest.model = MODEL_MAPPING[requestedModel] || requestedModel;

    nimRequest.extra_body = { ...nimRequest.extra_body, chat_template_kwargs: { thinking: true } };
    if (!nimRequest.max_tokens || nimRequest.max_tokens < 512) nimRequest.max_tokens = 4096;

    console.log(`📨 Request for: ${nimRequest.model}`);

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
           if (line.startsWith('data: ')) res.write(line + '\n');
        }
      });
      response.data.on('end', () => { clearInterval(heartbeat); res.end(); });
      response.data.on('error', () => { clearInterval(heartbeat); res.end(); });
    } else {
      res.json(response.data);
    }
  } catch (error) {
    console.error('❌ Proxy Error:', error.message);
    res.status(500).json({ error: "Proxy Error" });
  }
});

// Start Server - Let Railway handle the binding
app.listen(PORT, () => {
  console.log(`🚀 Proxy v2 Online`);
  console.log(`🔌 Listening on Port: ${PORT}`);
  console.log(`🔑 Key Loaded: ${NIM_API_KEY ? 'Yes' : 'NO'}`);
});
