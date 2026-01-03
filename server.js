const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================================================================
// 1. CONFIGURATION
// ==============================================================================

// High-Stability Agent
const agent = new https.Agent({ 
  keepAlive: true, 
  timeout: 600000 
});

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// MODEL MAPPING
const MODEL_MAPPING = {
  // New GLM Model
  'gpt-4o': 'z-ai/glm4.7',
  'glm-4': 'z-ai/glm4.7',

  // Existing Models
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

// 500MB Payload Limit
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Logger
app.use((req, res, next) => {
  if (req.method === 'POST') {
    const params = Object.keys(req.body).filter(k => k !== 'messages');
    console.log(`[${new Date().toISOString()}] 📨 Chat Request. Params: ${params.join(', ')}`);
  }
  next();
});

// ==============================================================================
// 3. ROUTES
// ==============================================================================

// 🔥 RAILWAY HEALTH CHECK FIX
// Railway pings this to see if the app is alive. If missing, it kills the app.
app.get('/', (req, res) => {
  res.status(200).send('Proxy is Running! 🚀');
});

app.get('/health', (req, res) => res.json({ status: 'ok', models: Object.keys(MODEL_MAPPING) }));

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({
    id: id, object: 'model', created: Date.now(), owned_by: 'nvidia-nim'
  }));
  res.json({ object: 'list', data: models });
});

// ==============================================================================
// 4. MAIN PROXY
// ==============================================================================

app.post('/v1/chat/completions', async (req, res) => {
  try {
    let nimRequest = { ...req.body };
    const requestedModel = nimRequest.model;
    nimRequest.model = MODEL_MAPPING[requestedModel] || requestedModel;

    nimRequest.extra_body = {
      ...nimRequest.extra_body,
      chat_template_kwargs: { thinking: true }
    };

    if (!nimRequest.max_tokens || nimRequest.max_tokens < 512) {
      nimRequest.max_tokens = 4096;
    }

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: { 
        'Authorization': `Bearer ${NIM_API_KEY}`, 
        'Content-Type': 'application/json' 
      },
      responseType: nimRequest.stream ? 'stream' : 'json',
      httpsAgent: agent,
      timeout: 600000
    });

    if (nimRequest.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let insideThinking = false;
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 10000);

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          if (line.includes('[DONE]')) { 
            clearInterval(heartbeat);
            res.write('data: [DONE]\n\n'); 
            continue; 
          }
          try {
            const json = JSON.parse(line.substring(6));
            let content = json.choices[0]?.delta?.content || '';
            if (!content) continue;

            if (!insideThinking && content.includes('<think>')) {
              insideThinking = true;
              content = content.split('<think>')[0];
            }
            if (insideThinking) {
              if (content.includes('</think>')) {
                insideThinking = false;
                content = content.split('</think>')[1] || '';
              } else { content = ''; }
            }
            if (content) {
              json.choices[0].delta.content = content;
              res.write(`data: ${JSON.stringify(json)}\n\n`);
            }
          } catch (e) { }
        }
      });
      response.data.on('end', () => { clearInterval(heartbeat); res.end(); });
      response.data.on('error', () => { clearInterval(heartbeat); res.end(); });

    } else {
      let fullContent = response.data.choices[0].message.content || "";
      fullContent = fullContent.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      response.data.choices[0].message.content = fullContent;
      res.json(response.data);
    }

  } catch (error) {
    console.error('Proxy Error:', error.message);
    res.status(500).json({ error: { message: "Proxy Error" } });
  }
});

// 🔥 NETWORK BINDING FIX
// Binding to '0.0.0.0' allows Railway to see the app from outside the container.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy running on port ${PORT}`);
});
