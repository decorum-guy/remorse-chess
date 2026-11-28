import { useId } from 'react';
import type { BatteryTracePoint, ShiftView, TeamId } from '../core';
import { eventCopy, teamName, text, type Language } from './copy';
import './RoundRecap.css';

type KnownPoint = Extract<BatteryTracePoint, { worldX: number }>;

interface RoundRecapProps {
  view: ShiftView;
  lang: Language;
  compact?: boolean;
}

/** Draw only recipient-visible historical coordinates, never the current room transform. */
export function RoundRecap({ view, lang, compact = false }: RoundRecapProps) {
  const titleId = useId();
  const descriptionId = useId();
  const recap = view.roundRecap;
  if (!recap || (view.phase !== 'intermission' && view.phase !== 'finished')) return null;

  const t = (ru: string, en: string) => text(lang, ru, en);
  const names = Object.fromEntries(view.seats.map(seat => [seat.seatId, seat.displayName]));
  const events = recap.events.filter(event => ['shift-start', 'pickup', 'drop', 'return', 'delivered'].includes(event.kind)).slice(-3);
  const returns = recap.events.filter(event => event.kind === 'return').map(event => event.tick);
  const segments: KnownPoint[][] = [];
  const gapEnds: KnownPoint[] = [];
  let segment: KnownPoint[] = [];
  let afterGap = false;

  for (const point of recap.batteryTrace) {
    if (point.gap) {
      if (segment.length) {
        gapEnds.push(segment[segment.length - 1]);
        segments.push(segment);
      }
      segment = [];
      afterGap = true;
      continue;
    }
    const previous = segment.at(-1);
    // A return moves the battery instantly. It is not a travelled route.
    if (previous && ((previous.mode !== 'pedestal' && point.mode === 'pedestal') || returns.some(tick => tick > previous.tick && tick <= point.tick))) {
      segments.push(segment);
      segment = [];
    }
    if (afterGap) gapEnds.push(point);
    afterGap = false;
    segment.push(point);
  }
  if (segment.length) segments.push(segment);

  const known = segments.flat();
  const first = known.at(0);
  const last = known.at(-1);
  const sharedEnd = !!(first && last && Math.hypot(first.worldX - last.worldX, first.worldZ - last.worldZ) < .00001);
  const hidden = recap.batteryTrace.some(point => point.gap && point.reason === 'hidden');
  const shortened = recap.batteryTrace.some(point => point.gap && point.reason === 'history-limit');
  const lastHidden = recap.batteryTrace.at(-1)?.gap === true;
  const sideTeam = (side: 'west' | 'east'): TeamId => view.goalSpace === side ? view.self.team : view.self.team === 'teal' ? 'amber' : 'teal';
  const roundLabel = `${t('Раунд', 'Round')} ${recap.round}`;
  const routeLabel = t('Путь батареи', 'Battery route');

  return <details className={`shift-round-recap${compact ? ' shift-round-recap--compact' : ''}`} open={compact ? undefined : true}>
    <summary>
      <span>{routeLabel}</span>
      <small>{roundLabel}</small>
      <span className="shift-round-recap__chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="shift-round-recap__body">
      <figure>
        <svg className="shift-round-recap__map" viewBox="-9 -5 34 26" role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
          <title id={titleId}>{`${routeLabel} · ${roundLabel}`}</title>
          <desc id={descriptionId}>{t('Наблюдения вашей команды на неподвижной схеме этажа. Скрытые участки не соединены. 1 — первое наблюдение; 2 — последнее.', 'Your team’s observations on a fixed floor plan. Hidden sections are not joined. 1 marks the first observation; 2 marks the last.')}</desc>
          <rect className="shift-round-recap__floor" x={-8} y={-4} width={32} height={24} />
          {Array.from({ length: 9 }, (_, index) => <rect className="shift-round-recap__cell" key={index} x={(index % 3) * 8 - 4} y={Math.floor(index / 3) * 8 - 4} width={8} height={8} />)}
          {(['west', 'east'] as const).map(side => {
            const x = side === 'west' ? -6 : 22;
            const team = sideTeam(side);
            return <g key={side} className={`shift-round-recap__goal shift-round-recap__${team}`}>
              <rect x={x - 2} y={-4} width={4} height={24} />
              {team === 'teal' ? <circle cx={x} cy={8} r={.9} /> : <path d={`M ${x} 6.9 l 1.1 1.1 -1.1 1.1 -1.1 -1.1 Z`} />}
              <title>{`${teamName(lang, team)} · ${t('сдача батареи', 'delivery zone')}`}</title>
            </g>;
          })}
          {segments.map((points, index) => <g key={index} className="shift-round-recap__observed-segment">
            {points.length === 1 && <circle className={`shift-round-recap__point shift-round-recap__${points[0].team || 'neutral'}`} cx={points[0].worldX} cy={points[0].worldZ} r={.16} />}
            {points.slice(1).map((point, pointIndex) => <line className={`shift-round-recap__path shift-round-recap__${point.team || 'neutral'}`} key={point.tick} x1={points[pointIndex].worldX} y1={points[pointIndex].worldZ} x2={point.worldX} y2={point.worldZ} />)}
          </g>)}
          {gapEnds.map((point, index) => <circle className="shift-round-recap__gap-edge" key={`${point.tick}-${index}`} cx={point.worldX} cy={point.worldZ} r={.45} />)}
          {first && !sharedEnd && <g className="shift-round-recap__marker">
            <circle cx={first.worldX} cy={first.worldZ} r={.72} />
            <text x={first.worldX} y={first.worldZ}>1</text>
          </g>}
          {last && <g className="shift-round-recap__marker shift-round-recap__marker--last">
            <circle cx={last.worldX} cy={last.worldZ} r={sharedEnd ? 1 : .72} />
            <text x={last.worldX} y={last.worldZ}>{sharedEnd ? '1·2' : '2'}</text>
          </g>}
        </svg>
        <figcaption>
          <span className="shift-round-recap__observations">{t('1 — первое · 2 — последнее наблюдение', '1 — first · 2 — last observation')}</span>
          <span>{t('Неподвижная сетка этажа. Путь по наблюдениям вашей команды.', 'Fixed floor grid. Route from your team’s observations.')}</span>
          {hidden && <span className="shift-round-recap__gap-note"><i aria-hidden="true" />{t('Разрыв — батарея была вне видимости.', 'Gap — the battery was out of sight.')}</span>}
          {lastHidden && <span>{t('Последняя точка — до потери видимости.', 'The last point is before visibility was lost.')}</span>}
          {shortened && <span>{t('Ранний участок сокращён; его точки не соединены.', 'An earlier section was shortened; its points are not joined.')}</span>}
          {returns.length > 0 && <span>{t('Возвраты в O показаны без соединяющей линии.', 'Returns to O have no connecting line.')}</span>}
          {!known.length && <span>{t('Точное положение батареи не наблюдалось.', 'No exact battery position was observed.')}</span>}
        </figcaption>
      </figure>
      <div className="shift-round-recap__events">
        <h3>{t('Последние события', 'Latest events')}</h3>
        {events.length ? <ol>{events.map(event => <li key={event.id} className={event.team ? `shift-round-recap__${event.team}` : undefined}>
          <span>{eventCopy(lang, event, names)}</span>
        </li>)}</ol> : <p>{t('В этом раунде не было сдвигов или действий с батареей.', 'No shifts or battery actions in this round.')}</p>}
      </div>
    </div>
  </details>;
}
