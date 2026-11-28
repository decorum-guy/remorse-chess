import { launchUrls, realtimeLaunchUrls } from '@iva-games/game-registry';
import { Avatar, Brand, Empty, GameArt, Icon, useLanguage } from "./ui";
import { PortalLink } from "./navigation";
import type { Game, User } from "./types";
import { gameDescription, gameTitle } from "./gameCopy";
import { chessHomeUrl } from "./links";

// Guest launch links are independent of availability in platform rooms.
export const chessLaunchUrls: Partial<Record<string, string>> = launchUrls({ development: import.meta.env.DEV, overrides: import.meta.env });
const roomLaunchUrls = realtimeLaunchUrls();

export function Catalogue({ page, games, user, busy, offline, retry, onPlay, onAbout }: {
  page: "home" | "chess" | "games";
  games: Game[];
  user: User | null;
  busy: boolean;
  offline: boolean;
  retry: () => void;
  onPlay: (game: Game) => void;
  onAbout: (game: Game) => void;
}) {
  const { t, lang } = useLanguage();
  const visibleGames = games.filter(game => {
    const chess = game.collectionId === "chess" || (!game.collectionId && !!chessLaunchUrls[game.gameId]);
    return page === "chess" ? chess : !chess;
  });
  return <div className="catalogue-shell">
    <header className="catalogue-header">
      <Brand />
      <nav className="catalogue-nav" aria-label={t("Разделы игр", "Game collections")}>
        <PortalLink href={chessHomeUrl} aria-current={page === "chess" ? "page" : undefined}>{t("Шахматы", "Chess")}</PortalLink>
        <PortalLink href="/games" aria-current={page === "games" ? "page" : undefined}>{t("Другие игры", "Other games")}</PortalLink>
      </nav>
      <div className="catalogue-account">
        {user ? <>
          <PortalLink href="/rooms" className="button secondary small">{t("Мои комнаты", "My rooms")}</PortalLink>
          <PortalLink href="/profile" className="catalogue-avatar" aria-label={t("Мой профиль", "My profile")}><Avatar player={user} /></PortalLink>
        </> : <PortalLink href="/login" className="button secondary small">{t("Войти", "Sign in")}</PortalLink>}
      </div>
    </header>
    <main className="catalogue-main">
      {offline && <div className="connection-banner" role="status">
        <span>{t("Нет связи. Попробуйте ещё раз.", "No connection. Please try again.")}</span>
        <button className="text-button" disabled={busy} onClick={retry}>{t("Обновить", "Refresh")}</button>
      </div>}
      <div className="catalogue-heading">
        <p className="greeting">{t("Хорошая компания. Твой ход.", "Good company. Your move.")}</p>
        <h1>{page === "home" ? t("Во что сыграем?", "What shall we play?")
          : page === "chess" ? t("Шахматы", "Chess") : t("Другие игры", "Other games")}</h1>
        <p>{page === "home" ? t("Выберите игру и собирайте своих.", "Pick a game and bring your people.")
          : page === "chess" ? t("Знакомая доска. Новые возможности.", "A familiar board. New possibilities.")
            : t("Сделки, неожиданные ходы и хорошие вечера вместе.", "Deals, unexpected moves and good evenings together.")}</p>
      </div>
      {page === "home" ? <div className="collection-grid">
        <PortalLink href={chessHomeUrl} className="collection-card">
          <GameArt kind="remorse" />
          <div className="collection-copy"><h2>{t("Шахматы", "Chess")}</h2>
            <p>{t("Remorse, Форсаж, Колосс и новые варианты шахмат.", "Remorse, Overdrive, Colossus and new chess variants.")}</p>
            <span>{t("Выбрать игру", "Choose a game")} <Icon name="arrow" size={19} /></span></div>
        </PortalLink>
        <PortalLink href="/games" className="collection-card">
          <GameArt kind="district" />
          <div className="collection-copy"><h2>{t("Другие игры", "Other games")}</h2>
            <p>{t("Игры для компании. Собирайтесь за одним столом.", "Games for good company. Gather around a table.")}</p>
            <span>{t("Выбрать игру", "Choose a game")} <Icon name="arrow" size={19} /></span></div>
        </PortalLink>
      </div> : visibleGames.length ? <div className="game-grid catalogue-games">
        {visibleGames.map(game => {
          const launch = chessLaunchUrls[game.gameId] ?? (game.status === 'available' ? roomLaunchUrls[game.gameId] : undefined);
          const available = game.status === "available";
          return <article className={`game-tile game-${game.gameId}`} key={game.gameId}>
            <GameArt kind={game.gameId} />
            <div className="game-tile-body">
              <div className="game-topline"><h2>{gameTitle(game, lang)}</h2>
                <span className={`tag ${available || launch ? "success" : ""}`}>{available || launch
                  ? t("Можно играть", "Ready to play") : t("Скоро здесь", "Coming soon")}</span></div>
              <p>{gameDescription(game.gameId, lang)}</p>
              <div className="game-bottom">
                <span className="game-players"><Icon name="friends" size={18} />
                  {game.minPlayers === game.maxPlayers ? game.minPlayers : `${game.minPlayers}–${game.maxPlayers}`}
                  {game.supportsBots && <span className="bot-capability"><Icon name="robot" size={17} />{t("Боты", "Bots")}</span>}
                </span>
                {launch ? <a className="button small primary" href={launch}>{t("Играть", "Play")}</a>
                  : <button className={`button small ${available ? "primary" : "secondary"}`} disabled={busy}
                    onClick={() => available ? onPlay(game) : onAbout(game)}>
                    {available ? !user ? t("Войти и играть", "Sign in to play") : !(user.emailVerified || user.telegramVerified)
                      ? t("Подтвердить почту", "Confirm email") : t("Собрать стол", "Gather a table") : t("Об игре", "About game")}
                  </button>}
              </div>
            </div>
          </article>;
        })}
      </div> : <Empty icon="games" title={t("Игры скоро появятся", "Games are coming soon")} />}
      <footer className="catalogue-footer">
        <PortalLink href="/">Iva Games</PortalLink>
        {page === "home" && <span>{t("Хороших вам голодных игр", "Happy Hunger Games")}</span>}
        {user ? <PortalLink href="/friends">{t("Мои друзья", "My friends")}</PortalLink>
          : <PortalLink href="/login">{t("Войти в аккаунт", "Sign in to your account")}</PortalLink>}
      </footer>
    </main>
  </div>;
}
