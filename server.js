const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================================================================
// CONFIGURATION
// ==============================================================================

// 1. High-Stability Agent
// Prevents the connection from dropping while the AI is "thinking" silently.
const agent = new https.Agent({ 
  keepAlive: true, 
  timeout: 600000 // 10 minutes
});

// 2. NVIDIA Credentials
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 3. Model Mapping
// Maps generic names (from Chub) to specific NVIDIA IDs.
const MODEL_MAPPING = {
  // Chub/Janitor Presets
  'gpt-4': 'z-ai/glm4.7',
  'gpt-4o': 'z-ai/glm4.7',
  'gpt-4-turbo': 'z-ai/glm4.7',
  'gpt-3.5-turbo': 'moonshotai/kimi-k2-thinking',
  
  // Direct Names
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'kimi-k2-thinking': 'moonshotai/kimi-k2-thinking'
};

// ==============================================================================
// MIDDLEWARE
// ==============================================================================

// Strict CORS for Chub AI / Janitor
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.options('*', cors());

// Increase Body Limit to 50MB (Fixes "High Payload" errors)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Request Logger (View in Railway Logs)
app.use((req, res, next) => {
  if (req.method === 'POST') {
    // Log meaningful params to prove they are working
    const params = Object.keys(req.body).filter(k => k !== 'messages');
    console.log(`[${new Date().toISOString()}] Chat Request. Params: ${params.join(', ')}`);
  }
  next();
});

// ==============================================================================
// ROUTES
// ==============================================================================

app.get('/health', (req, res) => res.json({ status: 'ok', scrubber: 'active', stability: 'high' }));

// Helper for clients checking available models
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({
    id: id, object: 'model', created: Date.now(), owned_by: 'nvidia-nim'
  }));
  res.json({ object: 'list', data: models });
});

// MAIN PROXY ENDPOINT
app.post('/v1/chat/completions', async (req, res) => {
  try {
    // 1. CLONE THE BODY
    // This ensures 'stop', 'top_k', 'repetition_penalty', 'seed' ALL pass through.
    let nimRequest = { ...req.body };

    // 2. RESOLVE MODEL NAME
    const requestedModel = nimRequest.model;
    nimRequest.model = MODEL_MAPPING[requestedModel] || requestedModel;

    // 3. FORCE THINKING MODE (Backend Only)
    // We inject this so the model is smart, even if the user didn't ask for it.
    nimRequest.extra_body = {
      ...nimRequest.extra_body,
      chat_template_kwargs: { thinking: true }
    };

    // 4. SAFETY CHECKS
    if (!nimRequest.max_tokens || nimRequest.max_tokens < 512) {
      nimRequest.max_tokens = 4096; // Prevent cut-offs
    }

    // 5. SEND TO NVIDIA
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: { 
        'Authorization': `Bearer ${NIM_API_KEY}`, 
        'Content-Type': 'application/json' 
      },
      responseType: nimRequest.stream ? 'stream' : 'json',
      httpsAgent: agent,
      timeout: 600000 // 10 minute timeout
    });

    // ==========================================================================
    // STREAM HANDLING (With Thinking Scrubber)
    // ==========================================================================
    if (nimRequest.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let insideThinking = false;
      let buffer = ""; // Small buffer to handle split tags

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          if (line.includes('[DONE]')) { res.write('data: [DONE]\n\n'); continue; }

          try {
            const json = JSON.parse(line.substring(6));
            let content = json.choices[0]?.delta?.content || '';

            if (!content) continue;

            // --- SCRUBBER LOGIC ---
            // Detect start of thinking
            if (!insideThinking && content.includes('<think>')) {
              insideThinking = true;
              // If there was text before the tag, keep it
              content = content.split('<think>')[0];
            }

            // Detect end of thinking
            if (insideThinking) {
              if (content.includes('</think>')) {
                insideThinking = false;
                // Keep text after the tag
                content = content.split('</think>')[1] || '';
              } else {
                // We are inside the thought bubble, block content
                content = ''; 
              }
            }
            // ----------------------

            // Only write if there is content remaining
            if (content) {
              json.choices[0].delta.content = content;
              res.write(`data: ${JSON.stringify(json)}\n\n`);
            }

          } catch (e) { 
            // Ignore incomplete JSON chunks
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', (err) => { console.error('Stream Error:', err.message); res.end(); });

    } else {
      // ========================================================================
      // NON-STREAM HANDLING (Regex Scrub)
      // ========================================================================
      let fullContent = response.data.choices[0].message.content || "";
      
      // Regex to delete <think>...</think> including newlines
      fullContent = fullContent.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      
      response.data.choices[0].message.content = fullContent;
      res.json(response.data);
    }

  } catch (error) {
    console.error('Proxy Error:', error.message);
    if (error.response) {
        console.error('NIM Data:', JSON.stringify(error.response.data));
    }
    
    res.status(error.response?.status || 500).json({ 
      error: { 
        message: "Proxy Error: Check logs for details",
        type: "server_error"
      } 
    });
  }
});

// Fallback for bad paths
app.all('*', (req, res) => res.status(404).json({ error: { message: "Path not found. Use /v1/chat/completions" } }));

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
