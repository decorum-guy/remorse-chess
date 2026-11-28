import { registration, launchUrls } from '@iva-games/game-registry';
import { AVATARS } from "./types";
import { AvatarArt, CHARACTER_AVATARS } from "./AvatarArt";
import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Language, PublicPlayer } from "./types";
import { PortalLink } from "./navigation";

export const LanguageContext = createContext<{
  lang: Language;
  t: (ru: string, en: string) => string;
  setLanguage?: (language: Language) => void;
}>({ lang: "ru", t: (ru) => ru });
export const useLanguage = () => useContext(LanguageContext);

export function Icon({
  name,
  size = 22,
}: {
  name:
    | "games"
    | "friends"
    | "rooms"
    | "mail"
    | "arrow"
    | "plus"
    | "close"
    | "check"
    | "logout"
    | "settings"
    | "copy"
    | "robot"
    | "lock";
  size?: number;
}) {
  const paths = {
    games: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="8" cy="8" r="1" />
        <circle cx="16" cy="8" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="8" cy="16" r="1" />
        <circle cx="16" cy="16" r="1" />
      </>
    ),
    friends: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5" />
      </>
    ),
    rooms: (
      <>
        <path d="m3 10 9-7 9 7v11H3ZM9 21v-8h6v8" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5" width="18" height="15" rx="3" />
        <path d="m4 7 8 6 8-6" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h15m-5-6 6 6-6 6" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4 10-10" />,
    logout: (
      <>
        <path d="M10 3H4v18h6M10 12h10m-5-5 5 5-5 5" />
      </>
    ),
    settings: (
      <>
        <path d="m12 3 2 3 4-1 1 4 3 3-3 2 1 4-4 1-4 3-2-3-4 1-1-4-3-4 3-2-1-4 4-1Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="13" height="13" rx="2" />
        <path d="M16 5V3H3v13h2" />
      </>
    ),
    robot: (
      <>
        <rect x="4" y="7" width="16" height="13" rx="4" />
        <path d="M12 3v4M2 11v5m20-5v5M9 16h6" />
        <circle cx="9" cy="11" r=".8" />
        <circle cx="15" cy="11" r=".8" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="3" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <PortalLink href="/" className="brand" aria-label="Iva Games">
      <span className="brand-die">
        <Icon name="games" size={34} />
      </span>
      {!compact && (
        <span>
          Iva<span className="brand-small">games</span>
        </span>
      )}
    </PortalLink>
  );
}

export function Avatar({
  player,
  bot = false,
  large = false,
  photoPreview,
}: {
  player: Pick<PublicPlayer, "displayName" | "handle" | "avatar" | "avatarVersion"> & { playerId?: string | null };
  bot?: boolean;
  large?: boolean;
  photoPreview?: string;
}) {
  const color =
    [...player.handle].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
  return (
    <span
      className={`avatar color-${color}${large ? " large" : ""}`}
      aria-hidden="true"
    >
      {bot ? (
        <Icon name="robot" />
      ) : player.avatar === "photo" && (photoPreview || player.playerId) ? (
        <img className="avatar-photo" src={photoPreview ?? `/api/platform/v1/avatars/${encodeURIComponent(player.playerId!)}?v=${encodeURIComponent(player.avatarVersion ?? "")}`} alt="" />
      ) : player.avatar && player.avatar !== "photo" && CHARACTER_AVATARS.includes(player.avatar) ? (
        <AvatarArt style={player.avatar} />
      ) : player.avatar && player.avatar !== "photo" ? (
        <span className="avatar-piece">{AVATARS[player.avatar]}</span>
      ) : (player.displayName || player.handle).slice(0, 2).toLocaleUpperCase()}
    </span>
  );
}

export function Empty({
  icon = "friends",
  title,
  children,
  action,
}: {
  icon?: Parameters<typeof Icon>[0]["name"];
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={32} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useLanguage();
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) {
          event.preventDefault();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label={t("Закрыть", "Close")}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function GameArt({ kind }: { kind: string }) {
  if (kind === 'forpost') return <div className="game-art forpost-art" aria-hidden="true" style={{ background: '#101c24' }}><img src={`${launchUrls({ development: import.meta.env.DEV, overrides: import.meta.env }).forpost}assets/forpost/cover.svg`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>;
  if (kind === "colossus")
    return (
      <div className="game-art colossus-art" aria-hidden="true">
        <svg viewBox="0 0 400 190" focusable="false">
          <path d="M35 145 198 88 367 145 203 199Z" fill="#35434a" stroke="#b29863" strokeWidth="2" />
          <path d="m75 132 170 56m-126-72 170 55m-127-71 169 54m-89-52-161 57m204-43-161 57m205-42-160 57" stroke="#87918c" strokeOpacity=".35" />
          <path d="m235 57 33-13 35 13v52l-35 17-33-17Z" fill="#536269" stroke="#b29863" strokeWidth="3" />
          <path d="m234 58 34 15 35-16m-35 16v52m-49-17 15-31m68 0 16 31" stroke="#b29863" strokeWidth="5" fill="none" />
          <path d="m252 48-5-18 16 9 5-19 6 19 17-9-6 18" fill="#b29863" />
          <path d="M250 87h11m13 0h11" stroke="#d9aa7e" strokeWidth="4" />
          <g fill="#e1d8bd" stroke="#b29863" strokeWidth="2">
            <path d="m125 122 6-30h16l6 30 5 7h-38Zm9-32V77h10v13m-16-7h22" />
            <path d="m177 154 5-20h11l5 20 4 5h-29Z" /><circle cx="187" cy="128" r="7" />
            <path d="m87 155 5-20h11l5 20 4 5H83Z" /><circle cx="97" cy="129" r="7" />
          </g>
        </svg>
      </div>
    );
  if (kind === "district")
    return (
      <div className="game-art district-art" aria-hidden="true">
        <div className="city-base" />
        <span className="city-building building-one">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="city-building building-two">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="city-building building-three">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="city-tree tree-one" />
        <span className="city-tree tree-two" />
        <span className="city-path" />
      </div>
    );
  if (kind === "harbor")
    return (
      <div className="game-art harbor-art" aria-hidden="true">
        <div className="harbor-sun" />
        <span className="harbor-wave wave-one" />
        <span className="harbor-wave wave-two" />
        <span className="harbor-boat" />
        <span className="harbor-mast" />
        <span className="harbor-sail" />
        <span className="harbor-cargo cargo-one" />
        <span className="harbor-cargo cargo-two" />
      </div>
    );
  if (registration(kind)?.collectionId === "chess")
    return (
      <div className={`game-art chess-art ${kind}`} aria-hidden="true">
        <span className="chess-board" />
        <span className="chess-piece">{kind === "remorse" ? "♞" : "♜"}</span>
        <span className="chess-spark spark-one" />
        <span className="chess-spark spark-two" />
      </div>
    );
  return (
    <div className="game-art lab-art" aria-hidden="true">
      <span className="lab-card card-one">
        <i />
        <i />
        <i />
      </span>
      <span className="lab-card card-two">
        <Icon name="games" size={54} />
      </span>
      <span className="lab-token token-one" />
      <span className="lab-token token-two" />
      <span className="lab-token token-three" />
    </div>
  );
}
