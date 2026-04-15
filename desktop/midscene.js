/**
 * midscene.js — Vision-driven browser automation agent
 *
 * Drop-in replacement for @midscene/web PuppeteerAgent.
 * Uses Claude Haiku (Vision) as the AI backend, with GPT-4o as fallback.
 *
 * Implements:
 *   aiBoolean(question)               — screenshot → yes/no answer
 *   aiTap(description)                — screenshot → find element → click
 *   aiInput(message, description)     — screenshot → find input → type
 *   aiScroll({ direction, scrollType, locate }) — scroll element/page
 */

const CLAUDE_MODEL  = 'claude-haiku-4-5-20251001';
const OPENAI_MODEL  = 'gpt-4o';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL    = 'https://api.openai.com/v1/chat/completions';

// In-memory coordinate cache: cacheId:url:description → {x, y}
const _coordCache = {};

class SparkAgent {
  /**
   * @param {import('puppeteer-core').Page} page
   * @param {object} opts
   * @param {string} opts.anthropicApiKey
   * @param {string} [opts.openaiApiKey]
   * @param {{ id: string }} [opts.cache]   — enable coordinate caching
   */
  constructor(page, opts = {}) {
    this.page           = page;
    this.anthropicKey   = opts.anthropicApiKey  || null;
    this.openaiKey      = opts.openaiApiKey     || process.env.OPENAI_API_KEY || null;
    this.cacheId        = opts.cache?.id        || null;
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE — screenshot
  // ─────────────────────────────────────────────────────────────
  async _screenshot() {
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 80 });
    return buf.toString('base64');
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE — send image + prompt to AI, return raw text
  // ─────────────────────────────────────────────────────────────
  async _ask(imageBase64, prompt, maxTokens = 120) {
    if (this.anthropicKey) {
      return this._askClaude(imageBase64, prompt, maxTokens);
    }
    if (this.openaiKey) {
      return this._askGPT4o(imageBase64, prompt, maxTokens);
    }
    throw new Error('[SparkAgent] No AI API key configured');
  }

  async _askClaude(imageBase64, prompt, maxTokens) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`Claude API: ${data.error.message}`);
    return (data.content?.[0]?.text || '').trim();
  }

  async _askGPT4o(imageBase64, prompt, maxTokens) {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openaiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`OpenAI API: ${data.error.message}`);
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE — extract JSON from AI response
  // ─────────────────────────────────────────────────────────────
  _parseJSON(text) {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) throw new Error(`No JSON in response: ${text.substring(0, 80)}`);
    return JSON.parse(m[0]);
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE — locate element by natural-language description
  // Returns { x, y } in absolute page pixels
  // ─────────────────────────────────────────────────────────────
  async _locate(description) {
    // Cache key: cacheId + page URL pattern + description
    const url = this.page.url().replace(/[?#].*/, ''); // strip query/hash
    const cacheKey = this.cacheId ? `${this.cacheId}|${url}|${description}` : null;
    if (cacheKey && _coordCache[cacheKey]) {
      console.log(`[SparkAgent] Cache hit — ${description.substring(0, 50)}`);
      return _coordCache[cacheKey];
    }

    const screenshot = await this._screenshot();
    const viewport   = await this.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

    const prompt =
      `Look at this screenshot carefully.\n` +
      `Find: "${description}"\n\n` +
      `Return ONLY valid JSON with the element's center position as fractions of the image (0.0 = left/top, 1.0 = right/bottom):\n` +
      `{"x": 0.52, "y": 0.87, "found": true}\n` +
      `If the element is not visible: {"x": 0, "y": 0, "found": false}\n` +
      `No markdown, no explanation — JSON only.`;

    const text   = await this._ask(screenshot, prompt, 80);
    const result = this._parseJSON(text);

    if (!result.found) throw new Error(`[SparkAgent] Element not found: ${description.substring(0, 80)}`);

    const coords = {
      x: Math.round(result.x * viewport.w),
      y: Math.round(result.y * viewport.h),
    };

    if (cacheKey) _coordCache[cacheKey] = coords;
    return coords;
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────

  /**
   * aiBoolean — answer a yes/no visual question about the current page.
   * @param {string} question
   * @returns {Promise<boolean>}
   */
  async aiBoolean(question) {
    const screenshot = await this._screenshot();
    const prompt     =
      `Look at this screenshot.\n${question}\n\n` +
      `Answer ONLY with the word: true  OR  false`;
    const text = await this._ask(screenshot, prompt, 20);
    const answer = text.toLowerCase().trim();
    return answer.startsWith('true');
  }

  /**
   * aiTap — click on the visually described element.
   * @param {string} description
   */
  async aiTap(description) {
    console.log(`[SparkAgent] Tapping: ${description.substring(0, 70)}`);
    const { x, y } = await this._locate(description);
    await this.page.mouse.click(x, y);
    await new Promise(r => setTimeout(r, 350));
    console.log(`[SparkAgent] ✅ Tapped (${x}, ${y})`);
  }

  /**
   * aiInput — type a message into the visually described input field.
   * First tries to find a real <textarea>/<input> near the located coords
   * so Puppeteer's type() fires proper key events.
   * @param {string} message
   * @param {string} description
   */
  async aiInput(message, description) {
    console.log(`[SparkAgent] Input into: ${description.substring(0, 70)}`);
    const { x, y } = await this._locate(description);

    // Click the element to focus it
    await this.page.mouse.click(x, y);
    await new Promise(r => setTimeout(r, 300));

    // Try to find an <input> or <textarea> at that position and use React-native setter
    const filled = await this.page.evaluate((px, py, msg) => {
      // Walk elements at the clicked position
      const els = document.elementsFromPoint(px, py);
      for (const el of els) {
        if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'hidden')) {
          el.focus();
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, msg); else el.value = msg;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, x, y, message);

    if (!filled) {
      // Fallback: type character by character via keyboard
      await this.page.keyboard.type(message, { delay: 25 });
    }

    console.log(`[SparkAgent] ✅ Typed: "${message.substring(0, 50)}"`);
  }

  /**
   * aiScroll — scroll within a visually described container, or the whole page.
   * @param {{ direction?: 'up'|'down', scrollType?: 'once'|'untilBottom', locate?: string }} opts
   */
  async aiScroll({ direction = 'down', scrollType = 'once', locate } = {}) {
    const delta    = direction === 'down' ? 600 : -600;
    const repeats  = scrollType === 'untilBottom' ? 6 : 1;

    if (locate) {
      console.log(`[SparkAgent] Scrolling ${direction} in: ${locate.substring(0, 60)}`);
      try {
        const { x, y } = await this._locate(locate);
        await this.page.mouse.move(x, y);
        for (let i = 0; i < repeats; i++) {
          await this.page.mouse.wheel({ deltaY: delta });
          await new Promise(r => setTimeout(r, 180));
        }
        return;
      } catch (e) {
        console.log(`[SparkAgent] Scroll locate failed (${e.message?.substring(0, 60)}) — falling back to window scroll`);
      }
    }

    // Window-level scroll fallback
    for (let i = 0; i < repeats; i++) {
      await this.page.evaluate((d) => window.scrollBy(0, d), delta);
      await new Promise(r => setTimeout(r, 180));
    }
  }

  /**
   * aiKeyboardPress — press a key, optionally focusing a described element first.
   * @param {string} key  e.g. 'Enter', 'Escape', 'Tab'
   * @param {string} [description]
   */
  async aiKeyboardPress(key, description) {
    if (description) {
      try {
        const { x, y } = await this._locate(description);
        await this.page.mouse.click(x, y);
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        // best effort — press the key anyway
      }
    }
    await this.page.keyboard.press(key);
  }
}

/** Clear the global coordinate cache (call when navigating to a new page type) */
function clearCache(cacheId) {
  if (cacheId) {
    Object.keys(_coordCache).forEach(k => { if (k.startsWith(cacheId + '|')) delete _coordCache[k]; });
  } else {
    Object.keys(_coordCache).forEach(k => delete _coordCache[k]);
  }
}

module.exports = { SparkAgent, clearCache };
