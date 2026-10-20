export function renderAiPage(canBack: boolean, qrUrl: string): string {
  const back = canBack ? `<button class="btn" data-back="1">返回</button>` : "";
  return `<div class="page ai-page" id="ai-root" data-qr="${esc(qrUrl)}">
    <div class="top">
      <div>
        <div class="crumbs"><span>ProtoView</span><span class="sep">/</span><span>AI</span></div>
        <h1>山海<span class="ai-heart-inline">♥</span></h1>
        <p class="ai-poem">所爱隔山海，山海亦可平<br/>消耗了 token，贡献点爱心<br/>尊重每个热爱开发的程序员</p>
      </div>
      <div class="actions">
        ${back}
      </div>
    </div>
    <div class="ai-stage">
      <div class="ai-game" id="ai-game">
        <div class="section-title">解谜 · 山海归位</div>
        <p class="muted">点击两张牌交换，拼出「山海平爱」。成功后会点亮爱心。</p>
        <div class="ai-board" id="ai-board"></div>
        <div class="ai-actions">
          <button class="btn" type="button" id="ai-shuffle">打乱重来</button>
          <span class="meta" id="ai-hint">目标：山 海 平 爱</span>
        </div>
      </div>
      <div class="ai-reward hidden" id="ai-reward">
        <div class="ai-heart-burst" aria-hidden="true">♥</div>
        <div class="section-title">解谜成功</div>
        <p class="lead">谢谢你的心意。扫一扫，给热爱开发的人一点支持。</p>
        <img class="ai-qr" id="ai-qr" alt="微信支付二维码" />
        <p class="meta">微信支付 · 辉</p>
      </div>
    </div>
  </div>`;
}

export const AI_PAGE_CSS = `
.ai-btn {
  position: relative;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, #7dd3fc 45%, var(--vscode-panel-border, transparent));
  background: linear-gradient(120deg, #0f172a, #1d4ed8 45%, #0891b2);
  color: #f8fafc;
  box-shadow: 0 0 0 0 color-mix(in srgb, #38bdf8 55%, transparent);
  animation: aiPulse 2.4s ease-in-out infinite;
}
.ai-btn:hover { filter: brightness(1.08); }
.ai-spark { display: inline-block; margin-right: 4px; animation: aiSpin 3.2s linear infinite; }
@keyframes aiPulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, #38bdf8 0%, transparent); }
  50% { box-shadow: 0 0 18px 2px color-mix(in srgb, #38bdf8 40%, transparent); }
}
@keyframes aiSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.ai-page {
  position: relative;
  overflow: hidden;
}
.ai-page::before {
  content: "";
  position: absolute; inset: -20% -10% auto;
  height: 280px;
  background:
    radial-gradient(circle at 20% 40%, color-mix(in srgb, #38bdf8 22%, transparent), transparent 55%),
    radial-gradient(circle at 80% 20%, color-mix(in srgb, #f472b6 18%, transparent), transparent 50%);
  pointer-events: none; z-index: 0;
}
.ai-page > * { position: relative; z-index: 1; }
.ai-poem {
  margin: 8px 0 0;
  font-size: 15px;
  line-height: 1.8;
  letter-spacing: 0.04em;
  color: var(--vscode-foreground);
}
.ai-heart-inline {
  color: #fb7185;
  margin-left: 6px;
  text-shadow: 0 0 12px color-mix(in srgb, #fb7185 60%, transparent);
}
.ai-stage {
  display: grid;
  grid-template-columns: 1.1fr .9fr;
  gap: 18px;
  margin-top: 22px;
  align-items: start;
}
@media (max-width: 860px) { .ai-stage { grid-template-columns: 1fr; } }
.ai-game, .ai-reward {
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border, var(--vscode-foreground)) 65%, transparent);
  border-radius: 16px;
  padding: 16px;
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground));
}
.ai-board {
  display: grid;
  grid-template-columns: repeat(4, minmax(64px, 1fr));
  gap: 10px;
  margin: 14px 0;
}
.ai-tile {
  aspect-ratio: 1;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, #38bdf8 35%, transparent);
  background: linear-gradient(160deg, color-mix(in srgb, #0ea5e9 18%, var(--vscode-editor-background)), var(--vscode-editor-background));
  color: inherit;
  font-size: 22px;
  font-weight: 650;
  cursor: pointer;
  transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease;
}
.ai-tile:hover { transform: translateY(-2px); }
.ai-tile.selected {
  border-color: #f472b6;
  box-shadow: 0 0 0 2px color-mix(in srgb, #f472b6 45%, transparent);
}
.ai-tile.done {
  border-color: #34d399;
  background: linear-gradient(160deg, color-mix(in srgb, #34d399 22%, var(--vscode-editor-background)), var(--vscode-editor-background));
}
.ai-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.ai-reward { text-align: center; }
.ai-reward.hidden { display: none; }
.ai-heart-burst {
  font-size: 42px;
  color: #fb7185;
  animation: heartBeat 1.1s ease-in-out infinite;
  text-shadow: 0 0 24px color-mix(in srgb, #fb7185 70%, transparent);
}
.ai-qr {
  width: min(260px, 100%);
  border-radius: 14px;
  margin: 12px auto 6px;
  display: block;
  box-shadow: 0 12px 36px color-mix(in srgb, #000 28%, transparent);
}
@keyframes heartBeat {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.12); }
}
`;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
