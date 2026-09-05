'use client';

import katex from 'katex';
import {
  Activity,
  Gauge,
  Grid3X3,
  Orbit,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Waves,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type ModelContextTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown;
};

declare global {
  interface Document {
    modelContext?: {
      registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => void | Promise<void>;
    };
  }
}

type Charge = { x: number; y: number; sign: 1 | -1 };
type MotionMode = 'breathing' | 'rotating';
type SimulationSettings = {
  mode: MotionMode;
  amplitude: number;
  frequency: number;
  separation: number;
  orientation: number;
  speed: number;
  viewRange: number;
  showFieldLines: boolean;
  showTransverseField: boolean;
  showWavefronts: boolean;
  showGrid: boolean;
};

const TAU = Math.PI * 2;

function Latex({ children, display = false, className = '' }: { children: string; display?: boolean; className?: string }) {
  const html = useMemo(
    () => katex.renderToString(children, { displayMode: display, throwOnError: false, strict: false }),
    [children, display],
  );
  const Tag = display ? 'div' : 'span';
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function rotate(x: number, y: number, angle: number) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: x * cosine - y * sine, y: x * sine + y * cosine };
}

function quadrupoleThird(time: number, amplitude: number, frequency: number) {
  const omega = TAU * frequency;
  const phase = omega * time;
  return -2 * amplitude * omega ** 3 * Math.cos(phase)
    - 4 * amplitude ** 2 * omega ** 3 * Math.sin(2 * phase);
}

function normalizedThird(time: number, amplitude: number, frequency: number) {
  const omega = TAU * frequency;
  const scale = Math.max(1e-9, (2 * amplitude + 4 * amplitude ** 2) * omega ** 3);
  return quadrupoleThird(time, amplitude, frequency) / scale;
}

function rotatingThirdComponent(time: number, frequency: number, orientation: number) {
  const alpha = (orientation * Math.PI) / 180 + TAU * frequency * time;
  return Math.sin(2 * alpha);
}

function polarPath(scale: number, orientation: number) {
  const points: string[] = [];
  const rotation = (orientation * Math.PI) / 180;
  for (let index = 0; index <= 360; index += 1) {
    const theta = (index / 360) * TAU;
    const angularAmplitude = Math.abs(Math.sin(2 * (theta - rotation)));
    const radius = 4 + 66 * angularAmplitude * scale;
    const x = 80 + radius * Math.cos(theta);
    const y = 80 - radius * Math.sin(theta);
    points.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `${points.join(' ')} Z`;
}

function drawRoundedPanel(context: CanvasRenderingContext2D, width: number, height: number) {
  const gradient = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.72);
  gradient.addColorStop(0, '#0b1a24');
  gradient.addColorStop(0.62, '#07131c');
  gradient.addColorStop(1, '#03090f');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function fieldAt(x: number, y: number, charges: Charge[]) {
  let fieldX = 0;
  let fieldY = 0;
  for (const charge of charges) {
    const dx = x - charge.x;
    const dy = y - charge.y;
    const squared = Math.max(90, dx * dx + dy * dy);
    const denominator = squared * Math.sqrt(squared);
    fieldX += (charge.sign * dx) / denominator;
    fieldY += (charge.sign * dy) / denominator;
  }
  return { x: fieldX, y: fieldY };
}

function combinedFieldAt(
  x: number,
  y: number,
  charges: Charge[],
  centerX: number,
  centerY: number,
  time: number,
  settings: SimulationSettings,
) {
  const nearField = fieldAt(x, y, charges);
  const dx = x - centerX;
  const dy = y - centerY;
  const radius = Math.max(18, Math.hypot(dx, dy));
  const theta = Math.atan2(dy, dx);
  const propagationSpeed = 74 / settings.viewRange;
  const retardedTime = time - radius / propagationSpeed;
  const retardedPhase = TAU * settings.frequency * retardedTime;
  const radiationOrientation = settings.mode === 'rotating'
    ? settings.orientation + (retardedPhase * 180) / Math.PI - 45
    : settings.orientation;
  const rotation = (radiationOrientation * Math.PI) / 180;
  const source = settings.mode === 'breathing'
    ? normalizedThird(retardedTime, settings.amplitude, settings.frequency)
    : 1;
  const transverse = source * Math.sin(2 * (theta - rotation));
  const radiationMagnitude = 0.0048 * transverse / (radius + 34);

  return {
    x: nearField.x - Math.sin(theta) * radiationMagnitude,
    y: nearField.y + Math.cos(theta) * radiationMagnitude,
  };
}

function traceFieldLine(
  startX: number,
  startY: number,
  direction: 1 | -1,
  charges: Charge[],
  centerX: number,
  centerY: number,
  time: number,
  settings: SimulationSettings,
  width: number,
  height: number,
  maximumSteps: number,
) {
  const points: Array<{ x: number; y: number }> = [];
  let x = startX;
  let y = startY;
  const stepLength = 2.65;
  for (let step = 0; step < maximumSteps; step += 1) {
    const field = combinedFieldAt(x, y, charges, centerX, centerY, time, settings);
    const magnitude = Math.hypot(field.x, field.y);
    if (!Number.isFinite(magnitude) || magnitude < 1e-11) break;
    x += direction * (field.x / magnitude) * stepLength;
    y += direction * (field.y / magnitude) * stepLength;
    points.push({ x, y });
    if (charges.some((charge) => Math.hypot(x - charge.x, y - charge.y) < 7.5)) break;
    if (x < 2 || x > width - 2 || y < 2 || y > height - 2) break;
    if (step > 28 && Math.hypot(x - startX, y - startY) < 3.5) break;
  }
  return points;
}

function strokeFieldLine(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  charges: Charge[],
  centerX: number,
  centerY: number,
  time: number,
  settings: SimulationSettings,
  width: number,
  height: number,
  maximumSteps: number,
) {
  const backward = traceFieldLine(startX, startY, -1, charges, centerX, centerY, time, settings, width, height, maximumSteps).reverse();
  const forward = traceFieldLine(startX, startY, 1, charges, centerX, centerY, time, settings, width, height, maximumSteps);
  if (backward.length + forward.length < 5) return;
  context.beginPath();
  const first = backward[0] ?? { x: startX, y: startY };
  context.moveTo(first.x, first.y);
  for (const point of backward.slice(1)) context.lineTo(point.x, point.y);
  context.lineTo(startX, startY);
  for (const point of forward) context.lineTo(point.x, point.y);
  context.stroke();
}

function drawFieldLines(
  context: CanvasRenderingContext2D,
  charges: Charge[],
  centerX: number,
  centerY: number,
  time: number,
  settings: SimulationSettings,
  width: number,
  height: number,
) {
  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';

  context.lineWidth = 0.85;
  context.strokeStyle = 'rgba(88, 225, 233, .24)';
  context.shadowColor = 'rgba(67, 214, 225, .18)';
  context.shadowBlur = 2;
  const columns = Math.min(14, Math.max(7, Math.round(7 + settings.viewRange)));
  const rows = Math.min(9, Math.max(5, Math.round(5 + settings.viewRange * 0.6)));
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const x = (column / (columns + 1)) * width;
      const y = (row / (rows + 1)) * height;
      if (Math.hypot(x - centerX, y - centerY) < 30) continue;
      strokeFieldLine(context, x, y, charges, centerX, centerY, time, settings, width, height, 185);
    }
  }

  context.lineWidth = 1.15;
  context.strokeStyle = 'rgba(88, 225, 233, .52)';
  context.shadowBlur = 3;
  const positives = charges.filter((charge) => charge.sign > 0);
  for (const source of positives) {
    const seedCount = 16;
    for (let seed = 0; seed < seedCount; seed += 1) {
      const seedAngle = (seed / seedCount) * TAU;
      const x = source.x + Math.cos(seedAngle) * 11;
      const y = source.y + Math.sin(seedAngle) * 11;
      strokeFieldLine(context, x, y, charges, centerX, centerY, time, settings, width, height, 260);
    }
  }
  context.restore();
}

function drawCharge(context: CanvasRenderingContext2D, charge: Charge, viewRange: number) {
  const color = charge.sign > 0 ? '#ff5c7b' : '#53ddff';
  const glow = charge.sign > 0 ? 'rgba(255,72,111,.45)' : 'rgba(49,208,255,.42)';
  const radius = Math.max(3.2, 9 / Math.sqrt(viewRange));
  const gradient = context.createRadialGradient(charge.x - radius * .3, charge.y - radius * .4, .5, charge.x, charge.y, radius * 1.25);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.22, color);
  gradient.addColorStop(1, glow);
  context.beginPath();
  context.fillStyle = gradient;
  context.shadowColor = color;
  context.shadowBlur = 14;
  context.arc(charge.x, charge.y, radius, 0, TAU);
  context.fill();
  context.shadowBlur = 0;
  if (radius >= 5) {
    context.fillStyle = '#061019';
    context.font = `700 ${Math.max(7, radius * 1.15)}px ui-sans-serif, system-ui`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(charge.sign > 0 ? '+' : '−', charge.x, charge.y + 0.4);
  }
}

function drawWavefronts(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  time: number,
  orientation: number,
  envelope: number,
  viewRange: number,
  width: number,
  height: number,
) {
  const maximumRadius = Math.hypot(width, height) * 0.65;
  const rotation = (orientation * Math.PI) / 180;
  const waveSpacing = Math.max(14, 62 / viewRange);
  const waveCount = Math.ceil(maximumRadius / waveSpacing) + 1;
  for (let wave = 0; wave < waveCount; wave += 1) {
    const radius = ((time * 74 / viewRange + wave * waveSpacing) % maximumRadius) + 18;
    const fade = Math.max(0, 1 - radius / maximumRadius);
    context.beginPath();
    for (let index = 0; index <= 144; index += 1) {
      const theta = (index / 144) * TAU;
      const quadrupole = Math.cos(4 * (theta - rotation));
      const localRadius = radius + quadrupole * 5.5 * envelope;
      const x = centerX + localRadius * Math.cos(theta);
      const y = centerY + localRadius * Math.sin(theta);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = `rgba(119, 236, 232, ${(.04 + .22 * envelope) * fade})`;
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawTransverseRadiation(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  time: number,
  settings: SimulationSettings,
  width: number,
  height: number,
) {
  const propagationSpeed = 74 / settings.viewRange;
  const ringSpacing = Math.max(16, 64 / settings.viewRange);
  const maximumRadius = Math.hypot(width, height) * 0.58;
  const leadingRadius = (time * propagationSpeed) % ringSpacing;
  const ringCount = Math.ceil(maximumRadius / ringSpacing) + 1;

  context.save();
  context.lineCap = 'round';
  context.lineWidth = 1.35;
  context.shadowColor = 'rgba(241, 203, 117, .45)';
  context.shadowBlur = 4;

  for (let ring = 0; ring < ringCount; ring += 1) {
    const radius = 24 + leadingRadius + ring * ringSpacing;
    if (radius > maximumRadius) continue;
    const retardedTime = time - radius / propagationSpeed;
    const retardedPhase = TAU * settings.frequency * retardedTime;
    const radiationOrientation = settings.mode === 'rotating'
      ? settings.orientation + (retardedPhase * 180) / Math.PI - 45
      : settings.orientation;
    const rotation = (radiationOrientation * Math.PI) / 180;
    const source = settings.mode === 'breathing'
      ? normalizedThird(retardedTime, settings.amplitude, settings.frequency)
      : 1;
    const radialFade = Math.max(0.18, 1 - radius / (maximumRadius * 1.16));

    for (let sample = 0; sample < 28; sample += 1) {
      const theta = (sample / 28) * TAU;
      const transverse = source * Math.sin(2 * (theta - rotation));
      if (Math.abs(transverse) < 0.12) continue;
      const x = centerX + radius * Math.cos(theta);
      const y = centerY + radius * Math.sin(theta);
      const tangentX = -Math.sin(theta) * Math.sign(transverse);
      const tangentY = Math.cos(theta) * Math.sign(transverse);
      const length = (3.5 + 8 * Math.abs(transverse)) * radialFade;
      const startX = x - tangentX * length * 0.48;
      const startY = y - tangentY * length * 0.48;
      const endX = x + tangentX * length * 0.52;
      const endY = y + tangentY * length * 0.52;
      const normalX = Math.cos(theta);
      const normalY = Math.sin(theta);

      context.strokeStyle = `rgba(241, 203, 117, ${0.2 + 0.62 * Math.abs(transverse) * radialFade})`;
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.moveTo(endX, endY);
      context.lineTo(endX - tangentX * 3 + normalX * 2, endY - tangentY * 3 + normalY * 2);
      context.moveTo(endX, endY);
      context.lineTo(endX - tangentX * 3 - normalX * 2, endY - tangentY * 3 - normalY * 2);
      context.stroke();
    }
  }
  context.restore();
}

function Toggle({ checked, onChange, label, icon: Icon }: { checked: boolean; onChange: (checked: boolean) => void; label: string; icon: typeof Waves }) {
  return (
    <label className="toggle-row">
      <span><Icon size={15} />{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function Range({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (value: number) => void }) {
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return (
    <label className="range-row">
      <span>{label}</span>
      <output>{value.toFixed(digits)}{unit}</output>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function QuadrupoleSimulator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [running, setRunning] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [time, setTime] = useState(0);
  const [settings, setSettings] = useState<SimulationSettings>({
    mode: 'breathing',
    amplitude: 0.28,
    frequency: 0.65,
    separation: 0.28,
    orientation: 0,
    speed: 1,
    viewRange: 1,
    showFieldLines: true,
    showTransverseField: true,
    showWavefronts: true,
    showGrid: true,
  });
  const settingsRef = useRef(settings);
  const runningRef = useRef(running);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  const updateSetting = <Key extends keyof SimulationSettings>(key: Key, value: SimulationSettings[Key]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let frame = 0;
    let simulationTime = 0;
    let previous = performance.now();

    const render = (now: number) => {
      const elapsed = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      const configuration = settingsRef.current;
      if (runningRef.current) simulationTime += elapsed * configuration.speed;

      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRoundedPanel(context, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      if (configuration.showGrid) {
        context.strokeStyle = 'rgba(127, 184, 202, .09)';
        context.lineWidth = 1;
        const spacing = Math.max(14, 42 / Math.sqrt(configuration.viewRange));
        for (let x = centerX % spacing; x < width; x += spacing) {
          context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
        }
        for (let y = centerY % spacing; y < height; y += spacing) {
          context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
        }
      }

      const phase = TAU * configuration.frequency * simulationTime;
      const breathing = configuration.mode === 'breathing'
        ? 1 + configuration.amplitude * 0.52 * Math.sin(phase)
        : 1;
      const distance = Math.min(width, height) * configuration.separation * breathing / configuration.viewRange;
      const baseAngle = (configuration.orientation * Math.PI) / 180;
      const angle = baseAngle + (configuration.mode === 'rotating' ? phase : 0);
      const localCharges: Charge[] = [
        { x: distance, y: 0, sign: 1 },
        { x: -distance, y: 0, sign: 1 },
        { x: 0, y: distance, sign: -1 },
        { x: 0, y: -distance, sign: -1 },
      ];
      const charges = localCharges.map((charge) => {
        const point = rotate(charge.x, charge.y, angle);
        return { x: centerX + point.x, y: centerY + point.y, sign: charge.sign };
      });

      const third = configuration.mode === 'breathing'
        ? normalizedThird(simulationTime, configuration.amplitude, configuration.frequency)
        : rotatingThirdComponent(simulationTime, configuration.frequency, configuration.orientation);
      const patternOrientation = configuration.mode === 'rotating'
        ? configuration.orientation + (phase * 180) / Math.PI - 45
        : configuration.orientation;
      const patternStrength = configuration.mode === 'rotating' ? 1 : Math.abs(third);
      if (configuration.showWavefronts) {
        drawWavefronts(context, centerX, centerY, simulationTime, patternOrientation, patternStrength, configuration.viewRange, width, height);
      }
      if (configuration.showTransverseField) {
        drawTransverseRadiation(context, centerX, centerY, simulationTime, configuration, width, height);
      }
      if (configuration.showFieldLines) {
        drawFieldLines(context, charges, centerX, centerY, simulationTime, configuration, width, height);
      }

      context.save();
      context.translate(centerX, centerY);
      context.rotate(angle);
      context.strokeStyle = 'rgba(255,255,255,.24)';
      context.setLineDash([4, 6]);
      const axisMargin = Math.max(8, 28 / Math.sqrt(configuration.viewRange));
      context.beginPath(); context.moveTo(-distance - axisMargin, 0); context.lineTo(distance + axisMargin, 0); context.stroke();
      context.beginPath(); context.moveTo(0, -distance - axisMargin); context.lineTo(0, distance + axisMargin); context.stroke();
      context.setLineDash([]);
      context.restore();

      for (const charge of charges) drawCharge(context, charge, configuration.viewRange);

      context.fillStyle = 'rgba(224, 241, 246, .68)';
      context.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.textAlign = 'left';
      context.fillText(`t = ${simulationTime.toFixed(2)} s`, 18, height - 20);

      setTime(simulationTime);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [resetKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setRunning((value) => !value);
      } else if (event.key.toLowerCase() === 'r') {
        setResetKey((value) => value + 1);
        setTime(0);
        setRunning(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: 'configure_quadrupole_simulator',
        title: 'Configure quadrupolar radiation 2D',
        description: 'Choose breathing or rotating quadrupole motion and set the field range, geometry, playback, and visible layers.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['breathing', 'rotating'] },
            amplitude: { type: 'number', minimum: 0.05, maximum: 0.45 },
            frequency: { type: 'number', minimum: 0.2, maximum: 2 },
            separation: { type: 'number', minimum: 0.16, maximum: 0.36 },
            orientation: { type: 'number', minimum: -45, maximum: 45 },
            animationSpeed: { type: 'number', minimum: 0.25, maximum: 2 },
            fieldRange: { type: 'number', minimum: 1, maximum: 10 },
            playback: { type: 'string', enum: ['run', 'pause', 'reset'] },
            fieldLines: { type: 'boolean' },
            transverseField: { type: 'boolean' },
            wavefronts: { type: 'boolean' },
            grid: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object.');
          const value = input as Record<string, unknown>;
          const ranges = {
            amplitude: [0.05, 0.45],
            frequency: [0.2, 2],
            separation: [0.16, 0.36],
            orientation: [-45, 45],
            animationSpeed: [0.25, 2],
            fieldRange: [1, 10],
          } as const;
          const next: Partial<SimulationSettings> = {};
          for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
            const candidate = value[key];
            if (candidate === undefined) continue;
            if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
              throw new Error(`${key} must be between ${minimum} and ${maximum}.`);
            }
            const settingKey = key === 'animationSpeed' ? 'speed' : key === 'fieldRange' ? 'viewRange' : key;
            Object.assign(next, { [settingKey]: candidate });
          }
          if (value.mode !== undefined) {
            if (value.mode !== 'breathing' && value.mode !== 'rotating') throw new Error('mode must be breathing or rotating.');
            next.mode = value.mode;
          }
          for (const [inputKey, settingKey] of [['fieldLines', 'showFieldLines'], ['transverseField', 'showTransverseField'], ['wavefronts', 'showWavefronts'], ['grid', 'showGrid']] as const) {
            if (value[inputKey] === undefined) continue;
            if (typeof value[inputKey] !== 'boolean') throw new Error(`${inputKey} must be boolean.`);
            Object.assign(next, { [settingKey]: value[inputKey] });
          }
          if (value.playback !== undefined && (typeof value.playback !== 'string' || !['run', 'pause', 'reset'].includes(value.playback))) {
            throw new Error('playback must be run, pause, or reset.');
          }
          if (Object.keys(next).length) setSettings((current) => ({ ...current, ...next }));
          if (value.playback === 'reset') {
            setResetKey((current) => current + 1);
            setTime(0);
            setRunning(true);
          } else if (value.playback !== undefined) {
            setRunning(value.playback === 'run');
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          return { ok: true, applied: value };
        },
      }, { signal: lifecycle.signal })).catch(() => undefined);
    } catch {
      // WebMCP is optional in browsers without a model context.
    }
    return () => lifecycle.abort();
  }, []);

  const phase = TAU * settings.frequency * time;
  const third = settings.mode === 'breathing'
    ? normalizedThird(time, settings.amplitude, settings.frequency)
    : rotatingThirdComponent(time, settings.frequency, settings.orientation);
  const patternOrientation = settings.mode === 'rotating'
    ? settings.orientation + (phase * 180) / Math.PI - 45
    : settings.orientation;
  const patternStrength = settings.mode === 'rotating' ? 1 : Math.abs(third);
  const relativePower = settings.mode === 'rotating' ? 1 : third * third;
  const guidePath = polarPath(1, patternOrientation);
  const activePath = polarPath(Math.max(0.015, patternStrength), patternOrientation);
  const trace = (() => {
    const points: string[] = [];
    const sampleCount = 180;
    for (let index = 0; index < sampleCount; index += 1) {
      const sampleTime = time - (sampleCount - 1 - index) * 0.0125;
      const sample = settings.mode === 'breathing'
        ? normalizedThird(sampleTime, settings.amplitude, settings.frequency)
        : rotatingThirdComponent(sampleTime, settings.frequency, settings.orientation);
      const x = 4 + (index / (sampleCount - 1)) * 252;
      const y = 42 - sample * 31;
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return points.join(' ');
  })();

  const isBreathing = settings.mode === 'breathing';
  const sourceTitle = isBreathing ? 'Breathing electric cross' : 'Rotating electric cross';
  const sourceDescription = isBreathing
    ? 'Two positive and two negative charges move radially, cancelling charge and dipole moment while the quadrupole strength varies.'
    : 'The four charges rotate rigidly about their common centre. The dipole moment remains zero while the quadrupole axes sweep through space.';

  const reset = () => {
    setResetKey((value) => value + 1);
    setTime(0);
    setRunning(true);
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark"><Grid3X3 size={19} /></div>
          <div><h1>Quadrupolar radiation 2D</h1><p>Electric quadrupole field simulator</p></div>
        </div>
        <div className="header-equation"><Latex>{String.raw`\sum_a q_a=0\,,\qquad \mathbf p=0`}</Latex></div>
        <div className="status-pill"><i className={running ? 'live' : ''} />{running ? 'Running' : 'Paused'}</div>
      </header>

      <section className="transport" aria-label="Playback controls">
        <button className="primary-action" onClick={() => setRunning(true)} disabled={running}><Play size={16} fill="currentColor" />Run</button>
        <button onClick={() => setRunning(false)} disabled={!running}><Pause size={16} fill="currentColor" />Pause</button>
        <button onClick={reset}><RotateCcw size={16} />Reset</button>
        <span className="transport-divider" />
        <Gauge size={16} />
        <label className="speed-inline">Animation speed<input type="range" min="0.25" max="2" step="0.05" value={settings.speed} onChange={(event) => updateSetting('speed', Number(event.target.value))} /><output>{settings.speed.toFixed(2)}×</output></label>
        <span className="shortcut">Space pause · R reset</span>
      </section>

      <div className="sim-workspace">
        <aside className="control-panel">
          <div className="panel-label">Source</div>
          <h2>{sourceTitle}</h2>
          <p className="panel-intro">{sourceDescription}</p>

          <Tabs value={settings.mode} onValueChange={(value) => updateSetting('mode', value as MotionMode)} className="mode-tabs">
            <TabsList aria-label="Quadrupole motion mode">
              <TabsTrigger value="breathing"><Activity />Breathing</TabsTrigger>
              <TabsTrigger value="rotating"><Orbit />Rotating</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className={`source-sketch ${isBreathing ? '' : 'is-rotating'}`} aria-hidden="true">
            <b>+</b><b>+</b><em>−</em><em>−</em>
            {!isBreathing && <div className="rotation-cue"><RotateCcw size={14} /><span>Rotating</span></div>}
          </div>

          <div className="formula-card">
            <Latex display>{isBreathing
              ? String.raw`a(t)=a_0\!\left[1+\varepsilon\sin(\omega t)\right]`
              : String.raw`\alpha(t)=\phi+\omega t,\qquad a(t)=a_0`}</Latex>
          </div>

          <div className="control-group">
            <div className="group-title"><span>Motion</span><Activity size={14} /></div>
            {isBreathing && <Range label="Breathing amplitude ε" value={settings.amplitude} min={0.05} max={0.45} step={0.01} onChange={(value) => updateSetting('amplitude', value)} />}
            <Range label={isBreathing ? 'Oscillation frequency' : 'Rotation frequency'} value={settings.frequency} min={0.2} max={2} step={0.05} unit=" Hz" onChange={(value) => updateSetting('frequency', value)} />
            <Range label="Mean separation a₀" value={settings.separation} min={0.16} max={0.36} step={0.01} unit=" m" onChange={(value) => updateSetting('separation', value)} />
            <Range label={isBreathing ? 'Orientation φ' : 'Initial orientation φ₀'} value={settings.orientation} min={-45} max={45} step={1} unit="°" onChange={(value) => updateSetting('orientation', value)} />
          </div>

          <div className="control-group display-group">
            <div className="group-title"><span>Display</span><Sparkles size={14} /></div>
            <Range label="Field view distance" value={settings.viewRange} min={1} max={10} step={0.25} unit="×" onChange={(value) => updateSetting('viewRange', value)} />
            <p className="layer-note">Each layer is independent and can be combined freely.</p>
            <Toggle label="Electric field lines · all space" icon={Activity} checked={settings.showFieldLines} onChange={(value) => updateSetting('showFieldLines', value)} />
            <Toggle label="Transverse radiation E field" icon={Orbit} checked={settings.showTransverseField} onChange={(value) => updateSetting('showTransverseField', value)} />
            <Toggle label="Wavefronts · all space" icon={Waves} checked={settings.showWavefronts} onChange={(value) => updateSetting('showWavefronts', value)} />
            <Toggle label="Reference grid" icon={Grid3X3} checked={settings.showGrid} onChange={(value) => updateSetting('showGrid', value)} />
          </div>
        </aside>

        <section className="field-panel">
          <div className="surface-heading">
            <div><span>Field view · {settings.viewRange.toFixed(2)}× farther</span><h2>{isBreathing ? 'Breathing quadrupole' : 'Rotating quadrupole'}</h2></div>
            <div className="legend"><span><i className="positive" />+q</span><span><i className="negative" />−q</span><span><i className="transverse" />E<sub>rad</sub></span><span><i className="wave" />wavefront</span></div>
          </div>
          <div className="canvas-wrap">
            <canvas ref={canvasRef} aria-label="Animated two-dimensional quadrupolar electric field" />
            <div className="canvas-formula" aria-label="Normalized third derivative of the quadrupole moment">
              <Latex>{isBreathing
                ? String.raw`\dddot Q/\dddot Q_{\max}=${third.toFixed(3)}`
                : String.raw`\dddot Q_{xx}/\dddot Q_{\max}=${third.toFixed(3)}`}</Latex>
            </div>
          </div>
          <div className="field-status"><span><i className="status-dot" />{isBreathing ? 'Breathing' : 'Rotating'} mode</span>{isBreathing && <span><b>ε</b> {settings.amplitude.toFixed(2)}</span>}<span><b>f</b> {settings.frequency.toFixed(2)} Hz</span><span><b>range</b> {settings.viewRange.toFixed(2)}×</span><span className="spacer" /><span>Net charge = 0 · dipole moment = 0</span></div>
        </section>

        <aside className="analysis-panel">
          <div className="panel-label">Radiation pattern</div>
          <h2>{isBreathing ? 'Pulsating four-lobed emission' : 'Rotating four-lobed emission'}</h2>
          <p className="analysis-note">{isBreathing
            ? 'The faint contour is the normalized envelope; the cyan contour follows the instantaneous source strength.'
            : 'The quadrupolar radiation lobes rotate continuously with constant total tensor magnitude.'}</p>

          <div className="polar-card">
            <svg viewBox="0 0 160 160" aria-label="Four-lobed quadrupolar radiation pattern">
              <circle cx="80" cy="80" r="66" className="polar-grid" />
              <circle cx="80" cy="80" r="34" className="polar-grid" />
              <line x1="8" y1="80" x2="152" y2="80" className="polar-axis" />
              <line x1="80" y1="8" x2="80" y2="152" className="polar-axis" />
              <path d={guidePath} className="polar-guide" />
              <path d={activePath} className="polar-active" />
              <circle cx="80" cy="80" r="3.2" className={third >= 0 ? 'origin-positive' : 'origin-negative'} />
            </svg>
          </div>

          <div className="metric-grid">
            <div className="metric-source"><span>Normalized component</span><strong><Latex>{isBreathing
              ? String.raw`\widehat{\dddot Q}=${third.toFixed(3)}`
              : String.raw`\widehat{\dddot Q}_{xx}=${third.toFixed(3)}`}</Latex></strong></div>
            <div><span>Relative power</span><strong>{relativePower.toFixed(3)}</strong></div>
          </div>

          <div className="trace-card">
            <div><span>Source history</span><Latex>{isBreathing ? String.raw`\dddot Q(t)` : String.raw`\dddot Q_{xx}(t)`}</Latex></div>
            <svg viewBox="0 0 260 84" preserveAspectRatio="none" aria-label="Third derivative of quadrupole moment versus time">
              <line x1="4" y1="42" x2="256" y2="42" />
              <polyline points={trace} />
            </svg>
          </div>

          <div className="radiation-equation">
            <span>Far-field angular power</span>
            <div className="equation-row">
              <Latex>{String.raw`\frac{\mathrm dP}{\mathrm d\Omega}\propto\left\lvert\mathbf n\times\bigl(\dddot{\mathbf Q}\cdot\mathbf n\bigr)\right\rvert^2`}</Latex>
              <span className="equation-divider" aria-hidden="true">·</span>
              <Latex>{isBreathing
                ? String.raw`I(\theta)\propto\sin^2\!\bigl(2(\theta-\phi)\bigr)`
                : String.raw`I(\theta,t)\propto\sin^2\!\left(2\left[\theta-\alpha(t)+\frac{\pi}{4}\right]\right)`}</Latex>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
