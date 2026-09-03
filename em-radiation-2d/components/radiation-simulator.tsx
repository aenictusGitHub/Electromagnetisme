'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  Activity,
  Circle,
  Crosshair,
  Download,
  Gauge,
  HelpCircle,
  Info,
  Magnet,
  Maximize2,
  Minus,
  MousePointer2,
  MoveRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Printer,
  Radar,
  RotateCcw,
  Route,
  ScanSearch,
  Waves,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Latex } from '@/components/latex';

declare global {
  interface Document {
    modelContext?: {
      registerTool: (
        tool: {
          name: string;
          title?: string;
          description: string;
          inputSchema: Record<string, unknown>;
          annotations?: {
            readOnlyHint?: boolean;
            untrustedContentHint?: boolean;
          };
          execute: (input: unknown) => unknown | Promise<unknown>;
        },
        options?: { signal?: AbortSignal },
      ) => void | Promise<void>;
    };
  }
}

type Trajectory =
  | 'mouse'
  | 'line'
  | 'dipole'
  | 'circle'
  | 'undulator'
  | 'racetrack'
  | 'bending';
type SamplingQuality = 'small' | 'medium' | 'large' | 'maximum';
type LineQuality = 'small' | 'medium' | 'large';

type Vec = { x: number; y: number };
type Parameters = {
  beta: number;
  amplitude: number;
  radius: number;
  lineStart: number;
  lineStop: number;
  straight: number;
  bendAngle: number;
  periods: number;
  undulatorPeriod: number;
  k: number;
};
type Layers = {
  fieldLines: boolean;
  wavefronts: boolean;
  nodes: boolean;
  trajectory: boolean;
  grid: boolean;
};
type Kinematics = { position: Vec; beta: Vec; betaDot: Vec };
type Telemetry = Kinematics & {
  time: number;
  speed: number;
  power: number;
  signal: number;
};

type ModeDefinition = {
  id: Trajectory;
  label: string;
  menuLabel: string;
  icon: typeof MousePointer2;
  description: string;
  formula: string;
  beta: number;
};

const C = 0.42;
const DEFAULT_PROBE = { x: 0.93, y: 0.48 };
const DEFAULT_TELEMETRY_INTERVAL_MS = 85;
const PATTERN_TELEMETRY_INTERVAL_MS = 30;
const PATTERN_DIRECTION_COUNT = 144;
const PATTERN_DIRECTIONS: Vec[] = Array.from(
  { length: PATTERN_DIRECTION_COUNT },
  (_, index) => {
    const angle = (index / PATTERN_DIRECTION_COUNT) * Math.PI * 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  },
);

const MODE_DEFINITIONS: ModeDefinition[] = [
  {
    id: 'mouse',
    label: 'By mouse',
    menuLabel: 'by Mouse',
    icon: MousePointer2,
    description: 'Drag the electron. Its speed stays below the wave speed.',
    formula: String.raw`\lVert\boldsymbol{\beta}\rVert=\frac{v}{c}<1`,
    beta: 0.99,
  },
  {
    id: 'line',
    label: 'Line',
    menuLabel: 'Line',
    icon: MoveRight,
    description: 'Constant velocity produces no radiation away from the endpoints.',
    formula: String.raw`\mathbf r(t)=\mathbf r_0+\boldsymbol{\beta}ct`,
    beta: 0.8,
  },
  {
    id: 'dipole',
    label: 'Dipole',
    menuLabel: 'Dipole Oscillation',
    icon: Activity,
    description: 'Sinusoidal motion creates the familiar two-lobed dipole pattern.',
    formula: String.raw`\begin{aligned}y(t)&=A\sin(\omega t),\\[2pt]\omega&=\frac{\beta_{\max}c}{A}\end{aligned}`,
    beta: 0.9,
  },
  {
    id: 'circle',
    label: 'Circle',
    menuLabel: 'Circle',
    icon: Circle,
    description: 'Circular acceleration forms a rotating synchrotron spiral.',
    formula: String.raw`\mathbf r(t)=R\bigl(\cos\omega t,\sin\omega t\bigr),\quad \omega=\frac{\beta c}{R}`,
    beta: 0.9,
  },
  {
    id: 'undulator',
    label: 'Undulator',
    menuLabel: 'Undulator',
    icon: Waves,
    description: 'Periodic transverse motion concentrates radiation in the forward direction.',
    formula: String.raw`\lambda_r=\frac{\lambda_u}{2\gamma^2}\left(1+\frac{K^2}{2}\right)`,
    beta: 0.95,
  },
  {
    id: 'racetrack',
    label: 'Racetrack',
    menuLabel: 'Racetrack',
    icon: Route,
    description: 'Radiation appears in the bends, not on the straight sections.',
    formula: String.raw`P\propto\lVert\dot{\boldsymbol{\beta}}\rVert^2`,
    beta: 0.8,
  },
  {
    id: 'bending',
    label: 'Bending magnet',
    menuLabel: 'Bending Magnet',
    icon: Magnet,
    description: 'A single magnetic bend creates a directed radiation pulse.',
    formula: String.raw`R=\frac{\gamma mv}{\lvert q\rvert B}`,
    beta: 0.9,
  },
];

const SAMPLING_QUALITY: Record<
  SamplingQuality,
  { rows: number; emitInterval: number; maxDpr: number; label: string }
> = {
  small: { rows: 160, emitInterval: 0.045, maxDpr: 2, label: '160' },
  medium: { rows: 320, emitInterval: 0.028, maxDpr: 2.5, label: '320' },
  large: { rows: 560, emitInterval: 0.016, maxDpr: 3, label: '560' },
  maximum: { rows: 1000, emitInterval: 0.009, maxDpr: 3, label: '1000' },
};

const FIELD_LINE_QUALITY: Record<LineQuality, { lines: number; label: string }> = {
  small: { lines: 24, label: '24' },
  medium: { lines: 48, label: '48' },
  large: { lines: 64, label: '64' },
};

const MODE_PARAMETER_DEFAULTS: Record<Trajectory, Partial<Parameters>> = {
  mouse: { beta: 0.99 },
  line: { beta: 0.8, lineStart: -0.5, lineStop: 0.5 },
  dipole: { beta: 0.9, amplitude: 0.1 },
  circle: { beta: 0.9, radius: 0.2 },
  undulator: { beta: 0.95, periods: 5, undulatorPeriod: 0.28, k: 1 },
  racetrack: { beta: 0.8, radius: 0.1, straight: 0.8 },
  bending: { beta: 0.9, radius: 0.5, bendAngle: 45 },
};

const INITIAL_PARAMETERS: Parameters = {
  beta: 0.9,
  amplitude: 0.1,
  radius: 0.2,
  lineStart: -0.5,
  lineStop: 0.5,
  straight: 0.8,
  bendAngle: 45,
  periods: 5,
  undulatorPeriod: 0.28,
  k: 1,
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function length(vector: Vec) {
  return Math.hypot(vector.x, vector.y);
}

function normalize(vector: Vec): Vec {
  const magnitude = length(vector);
  return magnitude < 1e-9
    ? { x: 1, y: 0 }
    : { x: vector.x / magnitude, y: vector.y / magnitude };
}

function stadiumPosition(distance: number, radius: number, straight: number): Vec {
  const perimeter = 2 * straight + 2 * Math.PI * radius;
  let s = ((distance % perimeter) + perimeter) % perimeter;
  if (s <= straight) return { x: -straight / 2 + s, y: radius };
  s -= straight;
  if (s <= Math.PI * radius) {
    const angle = Math.PI / 2 - s / radius;
    return {
      x: straight / 2 + radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    };
  }
  s -= Math.PI * radius;
  if (s <= straight) return { x: straight / 2 - s, y: -radius };
  s -= straight;
  const angle = -Math.PI / 2 - s / radius;
  return {
    x: -straight / 2 + radius * Math.cos(angle),
    y: radius * Math.sin(angle),
  };
}

function positionAt(mode: Trajectory, time: number, parameters: Parameters): Vec {
  const betaC = parameters.beta * C;
  switch (mode) {
    case 'line': {
      const x = clamp(parameters.lineStart + Math.max(0, time) * betaC, parameters.lineStart, parameters.lineStop);
      return { x, y: 0 };
    }
    case 'dipole': {
      const amplitude = Math.max(parameters.amplitude / 2, 0.025);
      const omega = betaC / amplitude;
      return { x: 0, y: amplitude * Math.sin(omega * time) };
    }
    case 'circle': {
      const radius = Math.max(parameters.radius, 0.05);
      const omega = betaC / radius;
      return {
        x: radius * Math.cos(omega * time),
        y: radius * Math.sin(omega * time),
      };
    }
    case 'undulator': {
      const period = Math.max(parameters.undulatorPeriod, 0.12);
      const total = period * parameters.periods;
      const amplitude = Math.min(0.12, 0.035 * parameters.k);
      const slope = (2 * Math.PI * amplitude) / period;
      const longitudinalSpeed = betaC / Math.sqrt(1 + (slope * slope) / 2);
      const distance = clamp(Math.max(0, time) * longitudinalSpeed, 0, total);
      return {
        x: -total / 2 + distance,
        y: amplitude * Math.sin((2 * Math.PI * distance) / period),
      };
    }
    case 'racetrack':
      return stadiumPosition(time * betaC, Math.max(parameters.radius, 0.06), parameters.straight);
    case 'bending': {
      const radius = Math.max(parameters.radius * 0.72, 0.12);
      const angle = (parameters.bendAngle * Math.PI) / 180;
      const entryX = -0.45;
      const distance = time * betaC - 0.34;
      if (distance < 0) return { x: entryX + distance, y: 0 };
      const arcLength = radius * angle;
      if (distance <= arcLength) {
        const phi = distance / radius;
        return {
          x: entryX + radius * Math.sin(phi),
          y: radius * (1 - Math.cos(phi)),
        };
      }
      const tail = distance - arcLength;
      return {
        x: entryX + radius * Math.sin(angle) + tail * Math.cos(angle),
        y: radius * (1 - Math.cos(angle)) + tail * Math.sin(angle),
      };
    }
    case 'mouse':
    default:
      return { x: 0, y: 0 };
  }
}

function sampleTrajectory(mode: Trajectory, time: number, parameters: Parameters): Kinematics {
  const epsilon = 0.0025;
  const position = positionAt(mode, time, parameters);
  const before = positionAt(mode, time - epsilon, parameters);
  const after = positionAt(mode, time + epsilon, parameters);
  let beta = {
    x: (after.x - before.x) / (2 * epsilon * C),
    y: (after.y - before.y) / (2 * epsilon * C),
  };
  const betaMagnitude = length(beta);
  if (betaMagnitude > 0.995) {
    beta = { x: (beta.x * 0.995) / betaMagnitude, y: (beta.y * 0.995) / betaMagnitude };
  }
  return {
    position,
    beta,
    betaDot: {
      x: (after.x - 2 * position.x + before.x) / (epsilon * epsilon * C),
      y: (after.y - 2 * position.y + before.y) / (epsilon * epsilon * C),
    },
  };
}

function aberratedDirection(angle: number, beta: Vec, enabled: boolean): Vec {
  const rest = { x: Math.cos(angle), y: Math.sin(angle) };
  if (!enabled) return rest;
  const speed = Math.min(length(beta), 0.995);
  if (speed < 1e-6) return rest;
  const direction = { x: beta.x / speed, y: beta.y / speed };
  const mu = rest.x * direction.x + rest.y * direction.y;
  const denominator = Math.max(1e-5, 1 + speed * mu);
  const gamma = 1 / Math.sqrt(1 - speed * speed);
  const parallel = (mu + speed) / denominator;
  const perpendicularScale = 1 / (gamma * denominator);
  const perpendicular = {
    x: rest.x - mu * direction.x,
    y: rest.y - mu * direction.y,
  };
  return normalize({
    x: parallel * direction.x + perpendicularScale * perpendicular.x,
    y: parallel * direction.y + perpendicularScale * perpendicular.y,
  });
}

function radiationValue(direction: Vec, beta: Vec, betaDot: Vec) {
  const kappa = Math.max(0.025, 1 - direction.x * beta.x - direction.y * beta.y);
  const projection = direction.x * betaDot.x + direction.y * betaDot.y;
  const vector = {
    x: (direction.x - beta.x) * projection - betaDot.x * kappa,
    y: (direction.y - beta.y) * projection - betaDot.y * kappa,
  };
  return (vector.x * vector.x + vector.y * vector.y) / Math.pow(kappa, 5);
}

type EmissionRow = { time: number; origin: Vec; directions: Float32Array };
type MouseState = {
  position: Vec;
  target: Vec;
  beta: Vec;
  betaDot: Vec;
  dragging: boolean;
};
type EngineState = {
  signature: string;
  time: number;
  lastEmission: number;
  rows: EmissionRow[];
  stepKey: number;
  mouse: MouseState;
  current: Kinematics;
  lastPatternTelemetry: number;
  lastTelemetry: number;
};

type CanvasProps = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  zoomCanvasRef: RefObject<HTMLCanvasElement | null>;
  mode: Trajectory;
  parameters: Parameters;
  samplingQuality: SamplingQuality;
  lineQuality: LineQuality;
  layers: Layers;
  running: boolean;
  waveSpeed: number;
  resetKey: number;
  stepKey: number;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  lightAberration: boolean;
  trackEmission: boolean;
  showZoom: boolean;
  showPattern: boolean;
  showMonitor: boolean;
  probe: Vec;
  onProbeChange: (probe: Vec) => void;
  onPatternTelemetry: (kinematics: Kinematics) => void;
  onTelemetry: (telemetry: Telemetry) => void;
};

function makeEmissionRow(
  time: number,
  kinematics: Kinematics,
  lineCount: number,
  lightAberration: boolean,
): EmissionRow {
  const directions = new Float32Array(lineCount * 2);
  for (let line = 0; line < lineCount; line += 1) {
    const direction = aberratedDirection((line / lineCount) * Math.PI * 2, kinematics.beta, lightAberration);
    directions[line * 2] = direction.x;
    directions[line * 2 + 1] = direction.y;
  }
  return { time, origin: { ...kinematics.position }, directions };
}

function resetEngine(configuration: CanvasProps): EngineState {
  const sampling = SAMPLING_QUALITY[configuration.samplingQuality];
  const fieldLines = FIELD_LINE_QUALITY[configuration.lineQuality];
  const rows: EmissionRow[] = [];
  for (let row = sampling.rows - 1; row >= 0; row -= 1) {
    const time = -row * sampling.emitInterval;
    const kinematics =
      configuration.mode === 'mouse'
        ? { position: { x: 0, y: 0 }, beta: { x: 0, y: 0 }, betaDot: { x: 0, y: 0 } }
        : sampleTrajectory(configuration.mode, time, configuration.parameters);
    rows.push(makeEmissionRow(time, kinematics, fieldLines.lines, configuration.lightAberration));
  }
  return {
    signature: '',
    time: 0,
    lastEmission: 0,
    rows,
    stepKey: configuration.stepKey,
    mouse: {
      position: { x: 0, y: 0 },
      target: { x: 0, y: 0 },
      beta: { x: 0, y: 0 },
      betaDot: { x: 0, y: 0 },
      dragging: false,
    },
    current:
      configuration.mode === 'mouse'
        ? { position: { x: 0, y: 0 }, beta: { x: 0, y: 0 }, betaDot: { x: 0, y: 0 } }
        : sampleTrajectory(configuration.mode, 0, configuration.parameters),
    lastPatternTelemetry: 0,
    lastTelemetry: 0,
  };
}

function engineSignature(configuration: CanvasProps) {
  const p = configuration.parameters;
  return [
    configuration.mode,
    configuration.samplingQuality,
    configuration.lineQuality,
    configuration.lightAberration,
    configuration.resetKey,
    p.beta,
    p.amplitude,
    p.radius,
    p.lineStart,
    p.lineStop,
    p.straight,
    p.bendAngle,
    p.periods,
    p.undulatorPeriod,
    p.k,
  ].join('|');
}

function updateMouse(engine: EngineState, delta: number, maximumBeta: number) {
  if (delta <= 0) return;
  const difference = {
    x: engine.mouse.target.x - engine.mouse.position.x,
    y: engine.mouse.target.y - engine.mouse.position.y,
  };
  const distance = length(difference);
  const maximumStep = maximumBeta * C * delta;
  const ratio = distance > maximumStep ? maximumStep / distance : 1;
  const next = {
    x: engine.mouse.position.x + difference.x * ratio,
    y: engine.mouse.position.y + difference.y * ratio,
  };
  const beta = {
    x: (next.x - engine.mouse.position.x) / (delta * C),
    y: (next.y - engine.mouse.position.y) / (delta * C),
  };
  engine.mouse.betaDot = {
    x: (beta.x - engine.mouse.beta.x) / delta,
    y: (beta.y - engine.mouse.beta.y) / delta,
  };
  engine.mouse.beta = beta;
  engine.mouse.position = next;
}

function drawTrajectory(
  context: CanvasRenderingContext2D,
  mode: Trajectory,
  parameters: Parameters,
  worldToScreen: (point: Vec) => Vec,
  engine: EngineState,
) {
  context.beginPath();
  let hasPoint = false;
  const addPoint = (point: Vec) => {
    const screen = worldToScreen(point);
    if (!hasPoint) context.moveTo(screen.x, screen.y);
    else context.lineTo(screen.x, screen.y);
    hasPoint = true;
  };

  if (mode === 'mouse') {
    for (let index = 0; index < engine.rows.length; index += 3) addPoint(engine.rows[index].origin);
  } else {
    let start = -1;
    let end = 8;
    if (mode === 'circle') end = (Math.PI * 2 * parameters.radius) / (parameters.beta * C);
    if (mode === 'racetrack') {
      end = (2 * parameters.straight + 2 * Math.PI * parameters.radius) / (parameters.beta * C);
      start = 0;
    }
    if (mode === 'dipole') {
      end = (Math.PI * 2 * Math.max(parameters.amplitude / 2, 0.025)) / (parameters.beta * C);
      start = 0;
    }
    for (let sample = 0; sample <= 180; sample += 1) {
      addPoint(positionAt(mode, start + ((end - start) * sample) / 180, parameters));
    }
  }
  context.strokeStyle = 'rgba(230, 230, 0, 0.68)';
  context.lineWidth = 1.15;
  context.setLineDash([4, 5]);
  context.stroke();
  context.setLineDash([]);
}

function SimulationCanvas(properties: CanvasProps) {
  const configurationRef = useRef(properties);
  configurationRef.current = properties;
  const engineRef = useRef<EngineState | null>(null);

  useEffect(() => {
    const canvas = properties.canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let animationFrame = 0;
    let previous = performance.now();
    let activeDrag: 'electron' | 'probe' | null = null;
    let activePointerId: number | null = null;

    const screenToWorld = (event: PointerEvent): Vec => {
      const configuration = configurationRef.current;
      const rect = canvas.getBoundingClientRect();
      const scale = Math.max(1e-6, Math.min(rect.width / 3.2, rect.height / 2.25) * configuration.zoom);
      return {
        x: (event.clientX - rect.left - rect.width / 2) / scale,
        y: -(event.clientY - rect.top - rect.height / 2) / scale,
      };
    };

    const probeFromPointer = (event: PointerEvent): Vec => {
      const configuration = configurationRef.current;
      const rect = canvas.getBoundingClientRect();
      const scale = Math.max(1e-6, Math.min(rect.width / 3.2, rect.height / 2.25) * configuration.zoom);
      const point = screenToWorld(event);
      const horizontalLimit = Math.max(0, (rect.width / 2 - 14) / scale);
      const verticalLimit = Math.max(0, (rect.height / 2 - 14) / scale);
      return {
        x: clamp(point.x, -horizontalLimit, horizontalLimit),
        y: clamp(point.y, -verticalLimit, verticalLimit),
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      const configuration = configurationRef.current;
      if (event.button !== 0 || !event.isPrimary) return;

      if (configuration.showMonitor && !(configuration.mode === 'mouse' && event.altKey)) {
        activeDrag = 'probe';
        activePointerId = event.pointerId;
        configuration.onProbeChange(probeFromPointer(event));
        canvas.setPointerCapture(event.pointerId);
        return;
      }

      const engine = engineRef.current;
      if (!engine || configuration.mode !== 'mouse') return;
      activeDrag = 'electron';
      activePointerId = event.pointerId;
      engine.mouse.dragging = true;
      engine.mouse.target = screenToWorld(event);
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return;
      if (activeDrag === 'probe') {
        configurationRef.current.onProbeChange(probeFromPointer(event));
        return;
      }
      const engine = engineRef.current;
      if (activeDrag !== 'electron' || !engine?.mouse.dragging) return;
      engine.mouse.target = screenToWorld(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (activePointerId !== null && event.pointerId !== activePointerId) return;
      const engine = engineRef.current;
      if (engine) engine.mouse.dragging = false;
      activeDrag = null;
      activePointerId = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const configuration = configurationRef.current;
      configuration.onZoomChange(clamp(configuration.zoom * Math.exp(-event.deltaY * 0.0012), 0.65, 4));
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const render = (now: number) => {
      const configuration = configurationRef.current;
      const signature = engineSignature(configuration);
      if (!engineRef.current || engineRef.current.signature !== signature) {
        engineRef.current = resetEngine(configuration);
        engineRef.current.signature = signature;
      }
      const engine = engineRef.current;
      const sampling = SAMPLING_QUALITY[configuration.samplingQuality];
      const lineModel = FIELD_LINE_QUALITY[configuration.lineQuality];
      const elapsed = Math.max(0, Math.min((now - previous) / 1000, 0.05));
      previous = now;

      let advance = configuration.running ? elapsed * configuration.waveSpeed : 0;
      if (!configuration.running && engine.stepKey !== configuration.stepKey) advance += 1 / 30;
      engine.stepKey = configuration.stepKey;

      if (advance > 0) {
        engine.time += advance;
        if (configuration.mode === 'mouse') {
          updateMouse(engine, advance, configuration.parameters.beta);
          engine.current = {
            position: { ...engine.mouse.position },
            beta: { ...engine.mouse.beta },
            betaDot: { ...engine.mouse.betaDot },
          };
        } else {
          engine.current = sampleTrajectory(configuration.mode, engine.time, configuration.parameters);
        }

        let emissions = 0;
        while (engine.lastEmission + sampling.emitInterval <= engine.time && emissions < 16) {
          engine.lastEmission += sampling.emitInterval;
          const kinematics =
            configuration.mode === 'mouse'
              ? engine.current
              : sampleTrajectory(configuration.mode, engine.lastEmission, configuration.parameters);
          engine.rows.push(
            makeEmissionRow(
              engine.lastEmission,
              kinematics,
              lineModel.lines,
              configuration.lightAberration,
            ),
          );
          if (engine.rows.length > sampling.rows) engine.rows.shift();
          emissions += 1;
        }
      }

      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const pixelBudgetDpr = Math.sqrt(6_000_000 / (width * height));
      const dpr = Math.max(
        1,
        Math.min(window.devicePixelRatio || 1, sampling.maxDpr, pixelBudgetDpr),
      );
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      const pixelsPerUnit = Math.max(1, Math.min(width / 3.2, height / 2.25) * configuration.zoom);
      const centerX = width / 2;
      const centerY = height / 2;
      const worldToScreen = (point: Vec) => ({
        x: centerX + point.x * pixelsPerUnit,
        y: centerY - point.y * pixelsPerUnit,
      });

      const backdrop = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
      backdrop.addColorStop(0, '#07121c');
      backdrop.addColorStop(0.58, '#030a10');
      backdrop.addColorStop(1, '#010306');
      context.fillStyle = backdrop;
      context.fillRect(0, 0, width, height);

      if (configuration.layers.grid) {
        const grid = pixelsPerUnit * 0.2;
        context.strokeStyle = 'rgba(89, 133, 148, 0.105)';
        context.lineWidth = 1;
        for (let x = width / 2 % grid; x < width; x += grid) {
          context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
        }
        for (let y = height / 2 % grid; y < height; y += grid) {
          context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
        }
        context.strokeStyle = 'rgba(102, 168, 182, 0.18)';
        context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
        context.beginPath(); context.moveTo(width / 2, 0); context.lineTo(width / 2, height); context.stroke();
      }

      const nodeAt = (row: EmissionRow, line: number) => {
        const age = Math.max(0, engine.time - row.time);
        return {
          x: row.origin.x + age * C * row.directions[line * 2],
          y: row.origin.y + age * C * row.directions[line * 2 + 1],
        };
      };

      if (configuration.layers.fieldLines) {
        context.strokeStyle = 'rgba(0, 200, 255, 0.55)';
        context.lineWidth = configuration.lineQuality === 'large' ? 0.72 : 0.82;
        context.beginPath();
        for (let line = 0; line < lineModel.lines; line += 1) {
          for (let rowIndex = 0; rowIndex < engine.rows.length; rowIndex += 1) {
            const row = engine.rows[rowIndex];
            const age = Math.max(0, engine.time - row.time);
            const x = centerX + (row.origin.x + age * C * row.directions[line * 2]) * pixelsPerUnit;
            const y = centerY - (row.origin.y + age * C * row.directions[line * 2 + 1]) * pixelsPerUnit;
            if (rowIndex === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
        }
        context.stroke();
      }

      const rowStride = Math.max(
        1,
        Math.round(14 / Math.max(1, C * sampling.emitInterval * pixelsPerUnit)),
      );
      if (configuration.layers.wavefronts) {
        context.strokeStyle = 'rgba(255, 100, 150, 0.46)';
        context.lineWidth = 0.8;
        context.beginPath();
        for (let rowIndex = engine.rows.length - 2; rowIndex >= 0; rowIndex -= rowStride) {
          for (let line = 0; line <= lineModel.lines; line += 1) {
            const point = worldToScreen(nodeAt(engine.rows[rowIndex], line % lineModel.lines));
            if (line === 0) context.moveTo(point.x, point.y);
            else context.lineTo(point.x, point.y);
          }
        }
        context.stroke();
      }

      if (configuration.layers.nodes) {
        context.fillStyle = 'rgba(238, 250, 255, 0.62)';
        for (let rowIndex = engine.rows.length - 2; rowIndex >= 0; rowIndex -= rowStride) {
          for (let line = 0; line < lineModel.lines; line += 2) {
            const point = worldToScreen(nodeAt(engine.rows[rowIndex], line));
            if (point.x > -2 && point.x < width + 2 && point.y > -2 && point.y < height + 2) {
              context.fillRect(point.x - 0.7, point.y - 0.7, 1.4, 1.4);
            }
          }
        }
      }

      if (configuration.trackEmission) {
        context.fillStyle = 'rgba(255, 116, 104, 0.28)';
        for (let index = 0; index < engine.rows.length; index += 8) {
          const point = worldToScreen(engine.rows[index].origin);
          context.fillRect(point.x - 1, point.y - 1, 2, 2);
        }
      }

      if (configuration.layers.trajectory) {
        drawTrajectory(context, configuration.mode, configuration.parameters, worldToScreen, engine);
      }

      if (configuration.showMonitor) {
        const probe = worldToScreen(configuration.probe);
        context.strokeStyle = 'rgba(255, 220, 119, 0.86)';
        context.lineWidth = 1;
        context.beginPath();
        context.arc(probe.x, probe.y, 7, 0, Math.PI * 2);
        context.moveTo(probe.x - 11, probe.y); context.lineTo(probe.x + 11, probe.y);
        context.moveTo(probe.x, probe.y - 11); context.lineTo(probe.x, probe.y + 11);
        context.stroke();
      }

      const charge = worldToScreen(engine.current.position);
      const glow = context.createRadialGradient(charge.x, charge.y, 0, charge.x, charge.y, 28);
      glow.addColorStop(0, 'rgba(255, 170, 104, 0.72)');
      glow.addColorStop(0.34, 'rgba(255, 76, 111, 0.28)');
      glow.addColorStop(1, 'rgba(255, 76, 111, 0)');
      context.fillStyle = glow;
      context.beginPath(); context.arc(charge.x, charge.y, 28, 0, Math.PI * 2); context.fill();
      const electron = context.createRadialGradient(
        charge.x - 1.4,
        charge.y - 1.5,
        0.35,
        charge.x,
        charge.y,
        4.4,
      );
      electron.addColorStop(0, '#fff3d0');
      electron.addColorStop(0.22, '#ffca72');
      electron.addColorStop(0.62, '#f05a50');
      electron.addColorStop(1, '#78172b');
      context.fillStyle = electron;
      context.strokeStyle = 'rgba(255, 147, 116, 0.92)';
      context.lineWidth = 0.85;
      context.beginPath();
      context.arc(charge.x, charge.y, 4.4, 0, Math.PI * 2);
      context.fill();
      context.stroke();

      if (configuration.mode === 'mouse') {
        const target = worldToScreen(engine.mouse.target);
        context.strokeStyle = engine.mouse.dragging ? 'rgba(255,255,255,.72)' : 'rgba(255,255,255,.25)';
        context.lineWidth = 1;
        context.beginPath(); context.arc(target.x, target.y, 10, 0, Math.PI * 2); context.stroke();
      }

      context.fillStyle = 'rgba(172, 204, 215, 0.6)';
      context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.fillText(`t = ${engine.time.toFixed(2)}   β = ${length(engine.current.beta).toFixed(3)}`, 16, height - 17);
      context.fillText('c = 1.000', width - 70, height - 17);

      const zoomCanvas = configuration.zoomCanvasRef.current;
      if (configuration.showZoom && zoomCanvas) {
        const zoomRect = zoomCanvas.getBoundingClientRect();
        const zoomWidth = Math.max(1, Math.round(zoomRect.width * dpr));
        const zoomHeight = Math.max(1, Math.round(zoomRect.height * dpr));
        if (zoomCanvas.width !== zoomWidth || zoomCanvas.height !== zoomHeight) {
          zoomCanvas.width = zoomWidth;
          zoomCanvas.height = zoomHeight;
        }
        const zoomContext = zoomCanvas.getContext('2d');
        if (zoomContext) {
          zoomContext.setTransform(1, 0, 0, 1, 0, 0);
          zoomContext.fillStyle = '#02070b';
          zoomContext.fillRect(0, 0, zoomWidth, zoomHeight);
          const sourceWidth = Math.max(28, Math.min(width, height) * 0.23) * dpr;
          const sourceHeight = sourceWidth * (zoomHeight / zoomWidth);
          zoomContext.imageSmoothingEnabled = true;
          zoomContext.drawImage(
            canvas,
            charge.x * dpr - sourceWidth / 2,
            charge.y * dpr - sourceHeight / 2,
            sourceWidth,
            sourceHeight,
            0,
            0,
            zoomWidth,
            zoomHeight,
          );
          zoomContext.strokeStyle = 'rgba(255,255,255,.28)';
          zoomContext.beginPath();
          zoomContext.moveTo(zoomWidth / 2 - 9, zoomHeight / 2); zoomContext.lineTo(zoomWidth / 2 + 9, zoomHeight / 2);
          zoomContext.moveTo(zoomWidth / 2, zoomHeight / 2 - 9); zoomContext.lineTo(zoomWidth / 2, zoomHeight / 2 + 9);
          zoomContext.stroke();
        }
      }

      if (
        configuration.showPattern &&
        now - engine.lastPatternTelemetry >= PATTERN_TELEMETRY_INTERVAL_MS
      ) {
        configuration.onPatternTelemetry(engine.current);
        engine.lastPatternTelemetry = now;
      }

      if (now - engine.lastTelemetry >= DEFAULT_TELEMETRY_INTERVAL_MS) {
        const relative = {
          x: configuration.probe.x - engine.current.position.x,
          y: configuration.probe.y - engine.current.position.y,
        };
        const direction = normalize(relative);
        const signal = radiationValue(direction, engine.current.beta, engine.current.betaDot) *
          Math.sin(engine.time * 3.4 - length(relative) / C);
        const acceleration = length(engine.current.betaDot);
        const gamma = 1 / Math.sqrt(Math.max(0.01, 1 - Math.pow(length(engine.current.beta), 2)));
        configuration.onTelemetry({
          ...engine.current,
          time: engine.time,
          speed: length(engine.current.beta),
          power: acceleration * acceleration * Math.min(60, Math.pow(gamma, 4)),
          signal: clamp(signal, -50, 50),
        });
        engine.lastTelemetry = now;
      }

      animationFrame = requestAnimationFrame(render);
    };

    animationFrame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animationFrame);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [properties.canvasRef]);

  return (
    <canvas
      ref={properties.canvasRef}
      className="simulation-canvas"
      role="img"
      aria-label="Animated two-dimensional electromagnetic radiation field"
    >
      Animated electromagnetic field simulation.
    </canvas>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return (
    <label className="range-control">
      <span>{label}</span>
      <output>{value.toFixed(digits)}{unit}</output>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function PowerPattern({ kinematics }: { kinematics: Kinematics }) {
  const { path, derivativeVector } = useMemo(() => {
    const points: Vec[] = [];
    const values = PATTERN_DIRECTIONS.map((direction) =>
      radiationValue(direction, kinematics.beta, kinematics.betaDot));
    const maximum = Math.max(...values, 1e-6);
    for (let index = 0; index <= PATTERN_DIRECTION_COUNT; index += 1) {
      const direction = PATTERN_DIRECTIONS[index % PATTERN_DIRECTION_COUNT];
      const normalized = values[index % PATTERN_DIRECTION_COUNT] / maximum;
      const radius = 8 + 49 * Math.sqrt(normalized);
      points.push({ x: 70 + radius * direction.x, y: 70 - radius * direction.y });
    }
    const nextPath = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
      .join(' ') + ' Z';
    const betaDotMagnitude = length(kinematics.betaDot);
    const derivativeVectorLength = Math.min(42, betaDotMagnitude * 18);
    const nextDerivativeVector = betaDotMagnitude > 1e-4
      ? {
          x: 70 - (kinematics.betaDot.x / betaDotMagnitude) * derivativeVectorLength,
          y: 70 + (kinematics.betaDot.y / betaDotMagnitude) * derivativeVectorLength,
        }
      : null;
    return { path: nextPath, derivativeVector: nextDerivativeVector };
  }, [kinematics.beta.x, kinematics.beta.y, kinematics.betaDot.x, kinematics.betaDot.y]);

  return (
    <div className="power-layout">
      <svg viewBox="0 0 140 140" aria-label="Polar radiation power pattern with the second time derivative of the dipole moment">
        <defs>
          <marker id="dipole-derivative-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L6,3 L0,6 Z" className="dipole-derivative-arrowhead" />
          </marker>
        </defs>
        <circle cx="70" cy="70" r="50" className="polar-grid" />
        <circle cx="70" cy="70" r="25" className="polar-grid" />
        <line x1="12" y1="70" x2="128" y2="70" className="polar-axis" />
        <line x1="70" y1="12" x2="70" y2="128" className="polar-axis" />
        <path d={path} className="polar-fill" />
        {derivativeVector ? (
          <line
            x1="70"
            y1="70"
            x2={derivativeVector.x}
            y2={derivativeVector.y}
            className="dipole-derivative-vector"
            markerEnd="url(#dipole-derivative-arrowhead)"
          />
        ) : (
          <circle cx="70" cy="70" r="4" className="dipole-derivative-zero" />
        )}
        <circle cx="70" cy="70" r="2.4" className="polar-source" />
      </svg>
      <Latex display className="pattern-equation">{String.raw`\begin{aligned}\frac{\mathrm dP}{\mathrm d\Omega}&\propto\frac{\left\lVert\mathbf n\times\mathbf u\right\rVert^2}{\left(1-\mathbf n\cdot\boldsymbol\beta\right)^5},\\[3pt]\mathbf u&=\left(\mathbf n-\boldsymbol\beta\right)\times\dot{\boldsymbol\beta}\\[7pt]\ddot{\mathbf p}(t)&=q\,\mathbf a(t)=-e\,\mathbf a(t)\\[-1pt]&=-ec\,\dot{\boldsymbol\beta}(t)\end{aligned}`}</Latex>
    </div>
  );
}

function MonitorChart({ values, probe }: { values: number[]; probe: Vec }) {
  const maximum = Math.max(1, ...values.map((value) => Math.abs(value)));
  const points = values
    .map((value, index) => `${(index / Math.max(1, values.length - 1)) * 260},${54 - (value / maximum) * 42}`)
    .join(' ');
  return (
    <div className="monitor-chart">
      <svg viewBox="0 0 260 108" preserveAspectRatio="none" aria-label="Electric field at the monitor probe">
        <line x1="0" y1="54" x2="260" y2="54" className="monitor-axis" />
        <polyline points={points} className="monitor-line" />
      </svg>
      <div className="monitor-caption">
        <span>Probe at <Latex>{String.raw`(${probe.x.toFixed(2)},\,${probe.y.toFixed(2)})`}</Latex> · drag the field to move</span>
        <strong>{(values.at(-1) ?? 0).toFixed(3)}</strong>
      </div>
    </div>
  );
}

function LayerToggle({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <Switch size="sm" checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </label>
  );
}

export function RadiationSimulator() {
  const [running, setRunning] = useState(true);
  const [mode, setMode] = useState<Trajectory>('mouse');
  const [parameters, setParameters] = useState<Parameters>({ ...INITIAL_PARAMETERS, beta: 0.99 });
  const [samplingQuality, setSamplingQuality] = useState<SamplingQuality>('medium');
  const [lineQuality, setLineQuality] = useState<LineQuality>('medium');
  const [waveSpeed, setWaveSpeed] = useState(1);
  const [layers, setLayers] = useState<Layers>({
    fieldLines: true,
    wavefronts: false,
    nodes: false,
    trajectory: true,
    grid: false,
  });
  const [lightAberration, setLightAberration] = useState(true);
  const [trackEmission, setTrackEmission] = useState(true);
  const [showZoom, setShowZoom] = useState(false);
  const [showPattern, setShowPattern] = useState(false);
  const [showMonitor, setShowMonitor] = useState(false);
  const [probe, setProbe] = useState<Vec>({ ...DEFAULT_PROBE });
  const [zoom, setZoom] = useState(1);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [stepKey, setStepKey] = useState(0);
  const [telemetry, setTelemetry] = useState<Telemetry>({
    time: 0,
    position: { x: 0, y: 0 },
    beta: { x: 0, y: 0 },
    betaDot: { x: 0, y: 0 },
    speed: 0,
    power: 0,
    signal: 0,
  });
  const [patternKinematics, setPatternKinematics] = useState<Kinematics>({
    position: { x: 0, y: 0 },
    beta: { x: 0, y: 0 },
    betaDot: { x: 0, y: 0 },
  });
  const [monitorHistory, setMonitorHistory] = useState<number[]>(Array(100).fill(0));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoomCanvasRef = useRef<HTMLCanvasElement>(null);

  const selectedMode = MODE_DEFINITIONS.find((definition) => definition.id === mode) ?? MODE_DEFINITIONS[0];

  const chooseMode = useCallback((nextMode: Trajectory) => {
    setMode(nextMode);
    setParameters((current) => ({ ...current, ...MODE_PARAMETER_DEFAULTS[nextMode] }));
    setMonitorHistory(Array(100).fill(0));
  }, []);

  const reset = useCallback(() => {
    setResetKey((value) => value + 1);
    setRunning(true);
    setMonitorHistory(Array(100).fill(0));
  }, []);

  const setParameter = <Key extends keyof Parameters>(key: Key, value: Parameters[Key]) => {
    setParameters((current) => ({ ...current, [key]: value }));
  };

  const toggleLayer = (key: keyof Layers, checked: boolean) => {
    setLayers((current) => ({ ...current, [key]: checked }));
  };

  const updateTelemetry = useCallback((next: Telemetry) => {
    setTelemetry(next);
    setMonitorHistory((current) => [...current.slice(-139), next.signal]);
  }, []);

  const exportImage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `radiation2d-${mode}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setRunning((value) => !value);
      } else if (event.key.toLowerCase() === 'r') {
        reset();
      } else if (event.key === 'ArrowRight') {
        setRunning(false);
        setStepKey((value) => value + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [reset]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const modes = MODE_DEFINITIONS.map((definition) => definition.id);
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'configure_radiation_simulator',
            title: 'Configure EM radiation 2D',
            description: 'Set the electron trajectory, playback state, wave speed, and visible field layers in the simulator.',
            inputSchema: {
              type: 'object',
              properties: {
                trajectory: { type: 'string', enum: modes },
                playback: { type: 'string', enum: ['run', 'pause', 'step'] },
                waveSpeed: { type: 'number', minimum: 0.25, maximum: 2 },
                fieldLines: { type: 'boolean' },
                wavefronts: { type: 'boolean' },
                nodes: { type: 'boolean' },
              },
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: false },
            async execute(input) {
              if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object.');
              const value = input as Record<string, unknown>;
              if (value.trajectory !== undefined) {
                if (typeof value.trajectory !== 'string' || !modes.includes(value.trajectory as Trajectory)) throw new Error('Unknown trajectory.');
                chooseMode(value.trajectory as Trajectory);
              }
              if (value.waveSpeed !== undefined) {
                if (typeof value.waveSpeed !== 'number' || value.waveSpeed < 0.25 || value.waveSpeed > 2) throw new Error('waveSpeed must be between 0.25 and 2.');
                setWaveSpeed(value.waveSpeed);
              }
              const nextLayers: Partial<Layers> = {};
              for (const key of ['fieldLines', 'wavefronts', 'nodes'] as const) {
                if (value[key] !== undefined) {
                  if (typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
                  nextLayers[key] = value[key];
                }
              }
              if (Object.keys(nextLayers).length) setLayers((current) => ({ ...current, ...nextLayers }));
              if (value.playback !== undefined) {
                if (!['run', 'pause', 'step'].includes(String(value.playback))) throw new Error('Unknown playback command.');
                if (value.playback === 'step') {
                  setRunning(false);
                  setStepKey((current) => current + 1);
                } else setRunning(value.playback === 'run');
              }
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              return { ok: true, applied: value };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => undefined);
      void Promise.resolve(
        context.registerTool(
          {
            name: 'reset_radiation_simulator',
            title: 'Reset EM radiation 2D',
            description: 'Reset the radiation history and resume the current trajectory from its initial state.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: false, untrustedContentHint: false },
            async execute(input) {
              if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input as object).length) throw new Error('This tool takes an empty object.');
              reset();
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              return { ok: true, playback: 'run' };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => undefined);
    } catch {
      // WebMCP is optional in browsers that do not expose a model context.
    }
    return () => lifecycle.abort();
  }, [chooseMode, reset]);

  return (
    <main className="sim-shell">
      <header className="app-header">
        <div className="brand-copy">
          <h1>EM radiation 2D</h1>
          <p>Electromagnetic field simulator</p>
        </div>
        <nav className="menu-bar" aria-label="Application menu">
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className="menu-trigger" />}>File</DropdownMenuTrigger>
            <DropdownMenuContent className="app-menu" align="start">
              <DropdownMenuItem onClick={exportImage}><Download />Export field image</DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.print()}><Printer />Print</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={reset}><RotateCcw />Reset simulation</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setGuideOpen(true)}><HelpCircle />Quick guide</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAboutOpen(true)}><Info />About EM radiation 2D</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>
        <div className="status-chip"><span className={running ? 'status-dot running' : 'status-dot'} />{running ? 'Running' : 'Paused'}</div>
      </header>

      <section className="control-strip" aria-label="Playback controls">
        <Button size="lg" className="run-button" onClick={() => setRunning(true)} disabled={running}>
          <img src="original-run.png" alt="" className="original-glyph" />Run
        </Button>
        <Button size="lg" variant="outline" className="toolbar-button" onClick={() => running ? setRunning(false) : setStepKey((value) => value + 1)} title={running ? 'Pause simulation' : 'Advance one step'}>
          <img src="original-pause.png" alt="" className="original-glyph" />{running ? 'Pause' : 'Step'}
        </Button>
        <Button size="lg" variant="ghost" className="toolbar-button" onClick={reset}><RotateCcw />Reset</Button>
        <div className="strip-divider" />
        <label className="speed-control">
          <Gauge />
          <span>Wave speed</span>
          <input type="range" min="0.25" max="2" step="0.05" value={waveSpeed} onChange={(event) => setWaveSpeed(Number(event.target.value))} />
          <output>{waveSpeed.toFixed(2)}×</output>
        </label>
        <span className="keyboard-hint"><kbd>Space</kbd> pause · <kbd>R</kbd> reset</span>
      </section>

      <div className={sidebarOpen ? 'workspace' : 'workspace sidebar-closed'}>
        <aside className="trajectory-panel" id="setup-panel">
          <div className="panel-heading">
            <div><span>Setup</span><h2>Trajectory</h2></div>
            <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(false)} aria-label="Close setup panel"><PanelLeftClose /></Button>
          </div>
          <div className="trajectory-list">
            {MODE_DEFINITIONS.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={mode === id ? 'trajectory-option selected' : 'trajectory-option'} onClick={() => chooseMode(id)} aria-pressed={mode === id}>
                <Icon /><span>{label}</span>
              </button>
            ))}
          </div>
          <div className="formula-card">
            <span className="formula-kicker">{selectedMode.label}</span>
            <Latex display>{selectedMode.formula}</Latex>
            <p>{selectedMode.description}</p>
          </div>
          <div className="parameter-section">
            <div className="section-title"><span>Parameters</span><strong>β = {parameters.beta.toFixed(2)}</strong></div>
            <RangeControl label={mode === 'mouse' || mode === 'dipole' ? 'Maximum velocity' : 'Particle velocity'} value={parameters.beta} min={0.5} max={0.99} step={0.01} onChange={(value) => setParameter('beta', value)} />
            {mode === 'line' && <>
              <RangeControl label="Start position" value={parameters.lineStart} min={-1.2} max={-0.1} step={0.1} unit=" m" onChange={(value) => setParameter('lineStart', Math.min(value, parameters.lineStop - 0.1))} />
              <RangeControl label="Stop position" value={parameters.lineStop} min={0.1} max={1.2} step={0.1} unit=" m" onChange={(value) => setParameter('lineStop', Math.max(value, parameters.lineStart + 0.1))} />
            </>}
            {mode === 'dipole' && <RangeControl label="Peak-to-peak 2A" value={parameters.amplitude} min={0.1} max={0.5} step={0.05} unit=" m" onChange={(value) => setParameter('amplitude', value)} />}
            {mode === 'circle' && <RangeControl label="Circle radius" value={parameters.radius} min={0.05} max={0.6} step={0.05} unit=" m" onChange={(value) => setParameter('radius', value)} />}
            {mode === 'undulator' && <>
              <RangeControl label="Periods N" value={parameters.periods} min={1} max={10} step={1} onChange={(value) => setParameter('periods', value)} />
              <RangeControl label="Undulator λu" value={parameters.undulatorPeriod} min={0.14} max={0.42} step={0.02} unit=" m" onChange={(value) => setParameter('undulatorPeriod', value)} />
              <RangeControl label="K parameter" value={parameters.k} min={0.1} max={3} step={0.1} onChange={(value) => setParameter('k', value)} />
            </>}
            {mode === 'racetrack' && <>
              <RangeControl label="Bending radius" value={parameters.radius} min={0.08} max={0.35} step={0.01} unit=" m" onChange={(value) => setParameter('radius', value)} />
              <RangeControl label="Straight section" value={parameters.straight} min={0.2} max={1} step={0.05} unit=" m" onChange={(value) => setParameter('straight', value)} />
            </>}
            {mode === 'bending' && <>
              <RangeControl label="Bending radius" value={parameters.radius} min={0.2} max={1} step={0.05} unit=" m" onChange={(value) => setParameter('radius', value)} />
              <RangeControl label="Bending angle" value={parameters.bendAngle} min={10} max={90} step={5} unit="°" onChange={(value) => setParameter('bendAngle', value)} />
            </>}
          </div>
          <details className="setup-details" open>
            <summary>Field plot</summary>
            <LayerToggle label="Electric field lines" checked={layers.fieldLines} onCheckedChange={(checked) => toggleLayer('fieldLines', checked)} />
            <LayerToggle label="Wavefronts" checked={layers.wavefronts} onCheckedChange={(checked) => toggleLayer('wavefronts', checked)} />
            <LayerToggle label="Node points" checked={layers.nodes} onCheckedChange={(checked) => toggleLayer('nodes', checked)} />
            <LayerToggle label="Trajectory" checked={layers.trajectory} onCheckedChange={(checked) => toggleLayer('trajectory', checked)} />
            <LayerToggle label="Reference grid" checked={layers.grid} onCheckedChange={(checked) => toggleLayer('grid', checked)} />
          </details>
          <details className="setup-details">
            <summary>Physical model</summary>
            <LayerToggle label="Light aberration" checked={lightAberration} onCheckedChange={setLightAberration} />
            <LayerToggle label="Track emission points" checked={trackEmission} onCheckedChange={setTrackEmission} />
          </details>
          <div className="model-size">
            <span>Field resolution</span>
            <div className="resolution-row">
              <span>Sampling</span>
              <div className="segment-control resolution-values">
                {(Object.keys(SAMPLING_QUALITY) as SamplingQuality[]).map((value) => (
                  <button type="button" key={value} className={samplingQuality === value ? 'active' : ''} onClick={() => setSamplingQuality(value)} aria-pressed={samplingQuality === value} aria-label={`${SAMPLING_QUALITY[value].rows} samples per field line`} title={`${SAMPLING_QUALITY[value].rows} samples per field line`}>{SAMPLING_QUALITY[value].label}</button>
                ))}
              </div>
            </div>
            <div className="resolution-row">
              <span>Field lines</span>
              <div className="segment-control resolution-values">
                {(Object.keys(FIELD_LINE_QUALITY) as LineQuality[]).map((value) => (
                  <button type="button" key={value} className={lineQuality === value ? 'active' : ''} onClick={() => setLineQuality(value)} aria-pressed={lineQuality === value} aria-label={`${FIELD_LINE_QUALITY[value].lines} field lines`} title={`${FIELD_LINE_QUALITY[value].lines} field lines`}>{FIELD_LINE_QUALITY[value].label}</button>
                ))}
              </div>
            </div>
            <small>{SAMPLING_QUALITY[samplingQuality].rows} samples per line × {FIELD_LINE_QUALITY[lineQuality].lines} field lines</small>
          </div>
        </aside>

        <section className="simulation-panel">
          <div className="canvas-topline">
            <div className="view-title">
              {!sidebarOpen && <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(true)} aria-label="Open setup panel"><PanelLeftOpen /></Button>}
              <div><span className="eyebrow">Field view</span><strong>{selectedMode.label}</strong></div>
            </div>
            <div className="legend">
              <span><i className="legend-line field" />Electric field</span>
              <span><i className="legend-line trajectory" />Trajectory</span>
              <span><i className="legend-line wave" />Wavefront</span>
              <span><i className="legend-dot" />Electron</span>
            </div>
            <div className="view-actions">
              <Button variant={showZoom ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowZoom((value) => !value)} aria-pressed={showZoom}><ScanSearch />Zoom</Button>
              <Button variant={showPattern ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowPattern((value) => !value)} aria-pressed={showPattern}><Radar />Pattern</Button>
              <Button variant={showMonitor ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowMonitor((value) => !value)} aria-pressed={showMonitor}><Crosshair />Monitor</Button>
            </div>
          </div>
          <div className="canvas-wrap">
            <SimulationCanvas
              canvasRef={canvasRef}
              zoomCanvasRef={zoomCanvasRef}
              mode={mode}
              parameters={parameters}
              samplingQuality={samplingQuality}
              lineQuality={lineQuality}
              layers={layers}
              running={running}
              waveSpeed={waveSpeed}
              resetKey={resetKey}
              stepKey={stepKey}
              zoom={zoom}
              onZoomChange={setZoom}
              lightAberration={lightAberration}
              trackEmission={trackEmission}
              showZoom={showZoom}
              showPattern={showPattern}
              showMonitor={showMonitor}
              probe={probe}
              onProbeChange={setProbe}
              onPatternTelemetry={setPatternKinematics}
              onTelemetry={updateTelemetry}
            />
            {showMonitor ? (
              <div className="interaction-hint"><Crosshair />{mode === 'mouse' ? 'Drag to move the probe · Alt/Option-drag to steer the electron' : 'Drag anywhere in the field to move the probe'}</div>
            ) : mode === 'mouse' ? (
              <div className="interaction-hint"><MousePointer2 />Drag anywhere to steer the electron</div>
            ) : null}
            <div className="floating-tools">
              {showZoom && <section className="floating-panel zoom-panel">
                <header><div><span>Zooming view</span><strong>×16 tracking particle</strong></div><button onClick={() => setShowZoom(false)} aria-label="Close zoomed view"><X /></button></header>
                <canvas ref={zoomCanvasRef} />
                <footer><button onClick={() => setZoom((value) => clamp(value / 1.2, 0.65, 4))}><Minus />Zoom out</button><output>{zoom.toFixed(1)}×</output><button onClick={() => setZoom((value) => clamp(value * 1.2, 0.65, 4))}><Plus />Zoom in</button></footer>
              </section>}
              {showPattern && <section className="floating-panel pattern-panel">
                <header><div><span>Radiation power pattern</span><strong>Instantaneous angular distribution</strong></div><button onClick={() => setShowPattern(false)} aria-label="Close power pattern"><X /></button></header>
                <PowerPattern kinematics={patternKinematics} />
              </section>}
              {showMonitor && <section className="floating-panel monitor-panel">
                <header><div><span>Field monitor</span><strong>Radiation signal vs. time</strong></div><button onClick={() => setShowMonitor(false)} aria-label="Close field monitor"><X /></button></header>
                <MonitorChart values={monitorHistory} probe={probe} />
              </section>}
            </div>
          </div>
          <footer className="status-bar">
            <span><i className={running ? 'status-dot running' : 'status-dot'} />{running ? 'Simulation active' : 'Simulation paused'}</span>
            <span><b>β</b> {telemetry.speed.toFixed(3)}</span>
            <span><b>t</b> {telemetry.time.toFixed(2)}</span>
            <span><b>Resolution</b> {SAMPLING_QUALITY[samplingQuality].rows} × {FIELD_LINE_QUALITY[lineQuality].lines}</span>
            <span className="status-spacer" />
            <span>Window width = 100 m</span>
          </footer>
        </section>
      </div>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="info-dialog">
          <DialogHeader>
            <DialogTitle className="about-attribution">Adapted from Radiation2D by Tsumoru Shintake, RIKEN/SPring-8</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogContent className="guide-dialog">
          <DialogHeader><DialogTitle>How to use EM radiation 2D</DialogTitle><DialogDescription>Move an electron and watch disturbances propagate at the wave speed.</DialogDescription></DialogHeader>
          <ol className="guide-steps"><li><strong>Choose a trajectory.</strong><span>Start with By mouse, Dipole, or Circle.</span></li><li><strong>Compare the layers.</strong><span>Turn wavefronts and node points on to reveal the moving-node lattice.</span></li><li><strong>Inspect the radiation.</strong><span>Open Power pattern or Field monitor, then change <Latex>{String.raw`\beta=v/c`}</Latex>.</span></li></ol>
          <div className="guide-equation"><Latex display>{String.raw`\mathbf P_{ij}(t)=\mathbf r(t_i)+c\,(t-t_i)\,\hat{\mathbf k}_{ij}`}</Latex><p>Each node starts at the electron’s emission position and propagates outward at <Latex>{String.raw`c`}</Latex>.</p></div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
