import { useEffect, useRef } from 'react';
import { fmtDate } from '../lib/dates.js';

const buildSeries = (usageMap) => {
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = fmtDate(date);
      const seconds = Number(usageMap[key] || 0);
      days.push({
        key,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        hours: Number((seconds / 3600).toFixed(2))
      });
  }
  return days;
};

export default function UsageChart({ usageMap }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parentWidth = canvas.parentElement?.clientWidth || 900;
      const dpr = window.devicePixelRatio || 1;
      const logicalWidth = parentWidth;
      const logicalHeight = 220;

      canvas.style.width = '100%';
      canvas.width = Math.floor(logicalWidth * dpr);
      canvas.height = Math.floor(logicalHeight * dpr);

      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);

      const W = logicalWidth;
      const H = logicalHeight;
      ctx.clearRect(0, 0, W, H);

      const days = buildSeries(usageMap);
      const observedMax = Math.max(0, ...days.map((d) => d.hours));
      const maxHours = Math.max(5, Math.ceil(observedMax));
      const pad = { t: 24, r: 16, b: 30, l: 32 };

      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, H - pad.b);
      ctx.lineTo(W - pad.r, H - pad.b);
      ctx.moveTo(pad.l, pad.t);
      ctx.lineTo(pad.l, H - pad.b);
      ctx.stroke();

      ctx.fillStyle = 'rgba(233,236,241,0.7)';
      ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
      for (let yVal = 0; yVal <= maxHours; yVal += 1) {
        const y = H - pad.b - ((H - pad.t - pad.b) * (yVal / maxHours));
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(W - pad.r, y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(161,171,189,0.9)';
        ctx.fillText(`${yVal}h`, 6, y + 4);
      }

      const gap = 12;
      const n = days.length;
      const barAreaW = W - pad.l - pad.r;
      const barW = Math.min(48, (barAreaW - gap * (n - 1)) / n);
      const x0 = pad.l + (barAreaW - (barW * n + gap * (n - 1))) / 2;

      days.forEach((d, index) => {
        const h = (H - pad.t - pad.b) * (d.hours / maxHours);
        const x = x0 + index * (barW + gap);
        const y = H - pad.b - h;
        const gradient = ctx.createLinearGradient(0, y, 0, y + h);
        gradient.addColorStop(0, '#7aa2ff');
        gradient.addColorStop(1, '#618dff');
        ctx.fillStyle = gradient;
        roundRect(ctx, x, y, barW, h, 8);
        ctx.fillStyle = 'rgba(161,171,189,0.95)';
        const textWidth = ctx.measureText(d.label).width;
        ctx.fillText(d.label, x + barW / 2 - textWidth / 2, H - 10);
      });
    };

    const handleResize = () => draw();
    draw();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [usageMap]);

  return (
    <section className="usage-card" aria-labelledby="usage-title">
      <h2 id="usage-title" className="section-title">
        Daily online time (last 7 days)
      </h2>
      <canvas ref={canvasRef} id="usage-chart" aria-label="Online time chart" role="img" />
      <div className="muted tiny">
        Time tracked while this page is visible. Stored locally on your device.
      </div>
    </section>
  );
}

function roundRect(ctx, x, y, w, h, radius) {
  if (w <= 0 || h <= 0) return;
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}
