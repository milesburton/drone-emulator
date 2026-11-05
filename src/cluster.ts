import type { Readouts } from './hud';

const need = <T extends Element>(root: ParentNode, selector: string): T => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector} in the instrument cluster`);
  return el;
};

const batteryColour = (charge: number): string =>
  charge > 0.3 ? '#34c759' : charge > 0.15 ? '#ff9f0a' : '#ff3b30';

/** Binds the cluster markup in index.html; the returned function paints one set of readouts. */
export const createCluster = (root: HTMLElement): ((r: Readouts) => void) => {
  const text = (field: string): HTMLElement => need<HTMLElement>(root, `[data-f="${field}"]`);
  const arrow = need<SVGGElement>(root, '#wind-arrow');
  const marker = need<SVGGElement>(root, '#heading-marker');
  const markerShape = need<SVGPolygonElement>(root, '#heading-marker polygon');
  const fill = need<HTMLElement>(root, '#battery-fill');
  const badge = text('status');
  const fields = {
    windFrom: text('wind-from'),
    windSpeed: text('wind-speed'),
    windKnots: text('wind-knots'),
    windEst: text('wind-est'),
    speed: text('speed'),
    altitude: text('altitude'),
    heading: text('heading'),
    battery: text('battery'),
    phase: text('phase'),
    waypoint: text('waypoint'),
    trip: text('trip'),
    flights: text('flights'),
    weather: text('weather'),
    ekf: text('ekf'),
    pressure: text('pressure'),
  };
  return (r) => {
    arrow.setAttribute('transform', `rotate(${r.wind.toward.toFixed(1)})`);
    marker.setAttribute('transform', `rotate(${r.heading.bearing.toFixed(1)})`);
    markerShape.setAttribute('fill', r.status.colour);
    fields.windFrom.textContent = `from ${r.wind.fromPoint} ${r.wind.from.toFixed(0)}°`;
    fields.windSpeed.textContent = r.wind.speed.toFixed(1);
    fields.windKnots.textContent = `${r.wind.knots.toFixed(0)} kn`;
    fields.windEst.textContent = `est ${r.wind.estimated.toFixed(1)}`;
    fields.speed.textContent = r.groundSpeed.toFixed(1);
    fields.altitude.textContent = r.altitude.toFixed(0);
    fields.heading.textContent = `${r.heading.bearing.toFixed(0).padStart(3, '0')}° ${r.heading.point}`;
    fields.battery.textContent = `${(r.battery * 100).toFixed(0)}%`;
    fill.style.width = `${r.battery * 100}%`;
    fill.style.background = batteryColour(r.battery);
    badge.textContent = `${r.status.icon} ${r.status.label}`;
    badge.style.color = r.status.colour;
    fields.phase.textContent = r.phase;
    fields.waypoint.textContent = r.waypoint;
    fields.trip.textContent = r.trip;
    fields.flights.textContent = r.flights;
    fields.weather.textContent = r.weather;
    fields.ekf.textContent = `${r.ekfError.toFixed(1)} m`;
    fields.pressure.textContent = `${r.pressure.toFixed(1)} hPa`;
  };
};
