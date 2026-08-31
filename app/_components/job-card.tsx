"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  brandFromPixels,
  NEUTRAL_PALETTE,
  paletteFor,
  type CardPalette,
} from "@/lib/goforay/card-palette";
import { employerDomainFromUrl } from "@/lib/goforay/card-logo";
import { jobCardView, type GoForayJobCard } from "@/lib/goforay/job-cards";

function JobCard({
  card,
  disabled,
  index,
  onApply,
  total,
}: {
  readonly card: GoForayJobCard;
  readonly disabled?: boolean;
  readonly index: number;
  readonly onApply?: (index: number) => void;
  readonly total: number;
}) {
  const view = jobCardView(card, index, total);
  const domain = employerDomainFromUrl(card.url);
  const logoSrc = domain
    ? `/api/job-card-logo?domain=${encodeURIComponent(domain)}`
    : undefined;
  const palette = useLogoPalette(logoSrc);

  return (
    <article
      className="flex w-[min(100%,28rem)] flex-col gap-4 overflow-hidden rounded-xl px-5 py-5"
      style={{ background: palette.ground, color: palette.ink }}
    >
      <div className="flex items-center gap-3">
        {logoSrc ? (
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white"
            style={{ boxShadow: `inset 0 0 0 1px ${palette.muted}` }}
          >
            <img alt="" className="size-9 object-contain" src={logoSrc} />
          </span>
        ) : null}
        <div className="min-w-0">
          <p className="truncate type-label">{view.company}</p>
          {view.sourceLabel ? (
            <p className="mt-1 type-caption" style={{ color: palette.muted }}>
              {view.sourceLabel}
            </p>
          ) : null}
        </div>
      </div>
      <h2 className="type-page-title text-balance">{view.title}</h2>
      {view.meta ? (
        <p className="type-supporting-body" style={{ color: palette.muted }}>
          {view.meta}
        </p>
      ) : null}
      {view.reasons.length ? (
        <ul className="flex flex-col gap-2">
          {view.reasons.map((reason) => (
            <li
              className="type-supporting-body flex items-start gap-2.5"
              key={reason}
            >
              <span
                className="mt-1.5 size-2.5 shrink-0"
                style={{ background: palette.accent }}
              />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className="mt-auto flex flex-col gap-3 border-t pt-4"
        style={{ borderColor: palette.accent }}
      >
        <div
          className="flex items-center justify-between type-caption"
          style={{ color: palette.muted }}
        >
          <span>{view.footerPosition}</span>
          <span>{view.via}</span>
        </div>
        {onApply ? (
          <Button
            className="self-start border-0"
            disabled={disabled}
            onClick={() => onApply(index)}
            size="sm"
            style={{ background: palette.accent, color: palette.ground }}
            type="button"
          >
            {view.applyLabel}
          </Button>
        ) : (
          <p
            className="text-center type-caption"
            style={{ color: palette.muted }}
          >
            {`reply "${view.applyReply}"`}
          </p>
        )}
      </div>
    </article>
  );
}

export function JobCardList({
  cards,
  disabled,
  onApply,
}: {
  readonly cards: readonly GoForayJobCard[];
  readonly disabled?: boolean;
  readonly onApply?: (index: number) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-3">
      {cards.map((card, offset) => (
        <JobCard
          card={card}
          disabled={disabled}
          index={offset + 1}
          key={`${card.url}:${String(offset)}`}
          onApply={onApply}
          total={cards.length}
        />
      ))}
    </div>
  );
}

function useLogoPalette(src: string | undefined) {
  const [sampled, setSampled] = useState<{
    palette: CardPalette;
    src: string;
  }>();
  const palette =
    src && sampled?.src === src ? sampled.palette : NEUTRAL_PALETTE;

  useEffect(() => {
    if (!src) return;
    const image = new Image();
    let cancelled = false;
    image.addEventListener("load", () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        const size = Math.min(
          160,
          image.naturalWidth || 160,
          image.naturalHeight || 160
        );
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.drawImage(image, 0, 0, size, size);
        const { data } = context.getImageData(0, 0, size, size);
        setSampled({ palette: paletteFor(brandFromPixels(data)), src });
      } catch {
        setSampled({ palette: NEUTRAL_PALETTE, src });
      }
    });
    image.addEventListener("error", () => {
      if (!cancelled) setSampled({ palette: NEUTRAL_PALETTE, src });
    });
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return palette;
}
