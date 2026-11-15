/**
 * StageFlow - the "<Name> Manufacturing Value Chain" panel: one card per stage (Raw Materials ->
 * Components -> Finished Goods) joined by arrows, each listing its items, with the box of concerned
 * ministries beneath. Clicking a stage heading opens the ministry-wise product mapping for that stage
 * (/value-chains/:id/mapping?stage=<stage_id>).
 *
 * Item names show whether their HS code has trade data linked (check mark), each stage states how many
 * 8-digit lines it maps, and ministry boxes link to the ministry dashboards.
 */
import { Fragment } from 'react';
import { Link } from 'react-router';
import { ArrowDown, ArrowRight, Check, Landmark, MousePointerClick } from 'lucide-react';
import type { ValueChainStage } from '@/api/types';
import { Card, MinistryPill, Tooltip } from '@/components';
import { fmtCode, plural } from '@/lib/format';
import { routes } from '@/lib/routes';
import { distinctItems } from '../utils';

export interface StageFlowProps {
  chainId: string;
  chainName: string;
  stages: ValueChainStage[];
  className?: string;
}

/** Item names listed per stage card before "+ n more". */
const MAX_ITEMS = 10;

export function StageFlow({ chainId, chainName, stages, className }: StageFlowProps) {
  const ordered = [...stages].sort((a, b) => a.order - b.order);
  return (
    <Card
      tone="navy"
      className={`${className ?? ''} overflow-hidden bg-[linear-gradient(150deg,#07182f_0%,#0b2140_100%)] ring-1 ring-white/[0.04]`}
      title={
        <span className="flex items-center gap-2 text-[17px] font-bold tracking-tight text-white">
          <span className="size-2 shrink-0 rounded-[2px] bg-kpi" aria-hidden />
          {chainName} Manufacturing Value Chain
        </span>
      }
      subtitle={<span className="text-on-navy-muted">Raw materials to finished goods, with the ministries concerned at each stage</span>}
    >
      {ordered.length ? (
        <ol className="flex flex-col items-stretch gap-2 md:flex-row" aria-label={`${chainName} value-chain stages`}>
          {ordered.map((s, i) => {
            const names = distinctItems(s.items);
            const linked = s.items.filter((it) => it.linked).length;
            return (
              <Fragment key={s.stage_id}>
                {i > 0 ? (
                  <li aria-hidden className="flex shrink-0 items-center justify-center text-kpi/80">
                    {/* animated stream of dots: inputs flowing into the next stage */}
                    <span className="hidden items-center md:flex">
                      <span className="atlas-flow-x" />
                      <ArrowRight className="-ml-1 size-4" />
                    </span>
                    <span className="flex flex-col items-center md:hidden">
                      <span className="atlas-flow-y" />
                      <ArrowDown className="-mt-1 size-4" />
                    </span>
                  </li>
                ) : null}
                <li className="flex min-w-0 flex-1 flex-col gap-2 animate-slide-in-up [animation-fill-mode:both]" style={{ animationDelay: `${i * 90}ms` }}>
                  <div className="flex flex-1 flex-col rounded-xl border border-white/10 bg-white/[0.055] p-3.5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ring-1 ring-white/[0.02] transition-colors hover:border-white/20 hover:bg-white/[0.075]">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[9.5px] font-bold tracking-[0.18em] text-on-navy-muted/70 uppercase">Stage {String(i + 1).padStart(2, '0')}</span>
                      <span className="size-1.5 rounded-full bg-kpi/75" aria-hidden />
                    </div>
                    <Link
                      to={routes.valueChainMapping(chainId, s.stage_id)}
                      className="group -mx-1 -mt-1 flex items-start gap-1.5 rounded-lg px-1 py-1 hover:bg-white/8 focus-visible:bg-white/10"
                      title={`Ministry-wise product mapping: ${s.name}`}
                    >
                      <span className="min-w-0 flex-1 text-[14px] leading-snug font-bold underline decoration-white/30 underline-offset-4 group-hover:decoration-white">
                        {s.name}
                      </span>
                      <MousePointerClick className="mt-0.5 size-4 shrink-0 opacity-60 group-hover:opacity-100" aria-hidden />
                    </Link>
                    {names.length ? (
                      <ul className="mt-2.5 space-y-1.5 text-[12px] leading-snug text-white/85">
                        {names.slice(0, MAX_ITEMS).map((n) => {
                          const codes = n.lines.map((l) => l.hs_code).filter(Boolean) as string[];
                          const tip = codes.length
                            ? `HS ${Array.from(new Set(codes)).map((c) => fmtCode(c)).join(', ')}${n.linked ? ' · trade data linked' : ''}`
                            : 'No HS code in the mapping';
                          return (
                            <li key={n.name} className="flex items-start gap-1.5">
                              <Tooltip content={tip}>
                                <span className="inline-flex items-start gap-1.5">
                                  {n.linked ? (
                                    <Check className="mt-[1px] size-3.5 shrink-0 text-[#7fe3bf]" aria-label="trade data linked" />
                                  ) : (
                                    <span className="mt-[6px] size-1.5 shrink-0 rounded-full bg-white/35" aria-hidden />
                                  )}
                                  <span>{n.name}</span>
                                </span>
                              </Tooltip>
                            </li>
                          );
                        })}
                        {names.length > MAX_ITEMS ? (
                          <li className="pl-5 text-white/55">
                            <Link to={routes.valueChainMapping(chainId, s.stage_id)} className="hover:underline">
                              + {names.length - MAX_ITEMS} more
                            </Link>
                          </li>
                        ) : null}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[12px] text-white/55">No items mapped for this stage yet.</p>
                    )}
                    <div className="mt-auto pt-3 text-[10.5px] text-white/50">
                      {plural(s.items.length, 'HS line')} · {linked} with trade data
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.035] p-3">
                    <div className="mb-1.5 flex items-center gap-1 text-[9.5px] font-bold tracking-[0.14em] text-on-navy-muted/75 uppercase">
                      <Landmark className="size-3" aria-hidden />
                      Concerned ministries
                    </div>
                    {s.ministries.length ? (
                      <div className="flex flex-wrap gap-1">
                        {s.ministries.map((m) => (
                          <MinistryPill key={m.id} ministry={m} size="xs" />
                        ))}
                      </div>
                    ) : (
                      <p className="text-[12px] font-medium text-on-navy">{s.ministry_text || 'Not available'}</p>
                    )}
                  </div>
                </li>
              </Fragment>
            );
          })}
        </ol>
      ) : (
        <p className="py-6 text-center text-sm text-on-navy-muted">No stages have been mapped for this value chain yet.</p>
      )}
      <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[12px] font-medium text-white/55 italic">
        <MousePointerClick className="size-4 shrink-0" aria-hidden />
        Click on a value-chain heading for ministry-wise product mapping across the {chainName.toLowerCase()} value chain.
      </p>
    </Card>
  );
}
