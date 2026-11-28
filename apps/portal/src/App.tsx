import type { DistrictMap } from "@iva-games/district";
import { AvatarPicker } from "./AvatarPicker";
import { DISTRICT_ISLAND_MAPS, DISTRICT_MAP_CATALOG, DISTRICT_MAPS, DISTRICT_RULES_VERSION } from "@iva-games/district";
import { DistrictPanel } from "./District";
import { TERRITORY_RULES, territoryMaps } from "@iva-games/district/territorial";
import { districtPreset, TerritorialLobby, TerritorialSettingsFields } from "./TerritorialLobby";
import { districtBotName } from "./districtCopy";
import { DistrictMapSelect, DistrictLobbyMap } from "./DistrictMap";
import type { AvatarChoice } from "./types";
import { friendRequestFeedback } from "./socialFeedback";
import { Catalogue } from "./Catalogue";
import { chessHomeUrl } from "./links";
import { gameDescription, gameTitle } from "./gameCopy";
import { go, PortalLink, readRoute } from "./navigation";
import type { Route } from "./navigation";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LabView } from "@iva-games/session-kit/lab";
import { getSession, PlatformError, request } from "./api";
import { Auth, readEntrance } from "./Auth";
import type { Perform } from "./Auth";
import { TelegramPanel } from "./TelegramPanel";
import { clearTelegramAttempt } from "./telegramFlow";
import {
  Avatar,
  Brand,
  Empty,
  GameArt,
  Icon,
  LanguageContext,
  Modal,
  useLanguage,
} from "./ui";
import type {
  BotDifficulty,
  Game,
  Invitation,
  Language,
  PublicPlayer,
  Room,
  Session,
  Social,
  TelegramStatus,
  User,
} from "./types";

const TerritorialMatch = lazy(() => import("./TerritorialDistrict").then(module => ({ default: module.TerritorialMatch })));
const ShiftRoom = lazy(() => import("./ShiftRoom").then(module => ({ default: module.ShiftRoom })));

const entranceAtLoad = readEntrance();
const emptySocial: Social = {
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
};

const errorCopy: Record<string, [string, string]> = {
  HUMANS_REQUIRED: ["Пригласите второго игрока или откройте практику «Сдвига».", "Invite a second player or open Shift practice."],
  INVALID_TEAMS: ["Проверьте команды: игроков должно быть поровну.", "Check the teams: they need equal numbers of players."],
  INVALID_ROLES: ["Выберите одного штурмана в каждой команде.", "Choose one navigator for each team."],
  NETWORK: [
    "Не получилось. Попробуйте ещё раз.",
    "Something went wrong. Please try again.",
  ],
  INVALID_CREDENTIALS: [
    "Почта или пароль не подходят.",
    "The email or password is incorrect.",
  ],
  INVALID_AVATAR_PHOTO: ["Не удалось сохранить фото. Выберите другое изображение.", "Could not save the photo. Choose another image."],
  EMAIL_NOT_VERIFIED: [
    "Сначала подтвердите почту — ссылка в письме.",
    "Please confirm your email using the link in your inbox.",
  ],
  EMAIL_UNVERIFIED: [
    "Сначала подтвердите почту — ссылка в письме.",
    "Please confirm your email using the link in your inbox.",
  ],
  EMAIL_TAKEN: [
    "Для этой почты уже есть аккаунт. Войдите или восстановите пароль.",
    "An account already uses this email. Sign in or recover your password.",
  ],
  HANDLE_TAKEN: [
    "Это имя пользователя уже занято. Выберите другое.",
    "This username is taken. Choose another one.",
  ],
  RATE_LIMITED: [
    "Слишком много попыток. Немного подождите и повторите.",
    "Too many attempts. Wait a little and retry.",
  ],
  ROOM_FULL: ["В комнате нет мест.", "The room is full."],
  STALE_REVISION: [
    "Игра обновилась. Выберите ещё раз.",
    "The game changed. Choose again.",
  ],
  REVISION_CONFLICT: [
    "Игра обновилась. Выберите ещё раз.",
    "The game changed. Choose again.",
  ],
  NOT_READY: [
    "Для старта все участники должны подтвердить готовность.",
    "Everyone must be ready before the game starts.",
  ],
  INVITATION_EXPIRED: [
    "Приглашение истекло. Попросите отправить новое.",
    "This invitation expired. Ask for a new one.",
  ],
  INVITE_EXPIRED: [
    "Приглашение истекло. Попросите отправить новое.",
    "This invitation expired. Ask for a new one.",
  ],
  TOKEN_INVALID: [
    "Ссылка недействительна или уже использована. Запросите новое письмо.",
    "This link is invalid or has been used. Request a new email.",
  ],
  INVALID_TOKEN: [
    "Ссылка недействительна или уже использована. Запросите новое письмо.",
    "This link is invalid or has been used. Request a new email.",
  ],
  TOKEN_EXPIRED: [
    "Срок ссылки истёк. Запросите новое письмо.",
    "This link expired. Request a new email.",
  ],
  FORBIDDEN: [
    "У вашего аккаунта нет доступа к этому действию.",
    "Your account cannot perform this action.",
  ],
  NOT_FOUND: [
    "Это приглашение или комната больше недоступны.",
    "This invitation or room is no longer available.",
  ],
  NOT_FRIENDS: [
    "Приглашать можно только принятых друзей.",
    "You can only invite accepted friends.",
  ],
  GAME_UNAVAILABLE: ["Игра скоро появится здесь.", "This game is coming soon."],
  GAME_TIMEOUT: [
    "Не получилось. Попробуйте ещё раз.",
    "Something went wrong. Please try again.",
  ],
  GAME_VERSION_UNAVAILABLE: [
    "Игра обновилась. Создайте новую комнату.",
    "The game was updated. Create a new room.",
  ],
  BLOCKED: [
    "Действие недоступно из-за блокировки.",
    "A block prevents this action.",
  ],
  SESSION_REQUIRED: [
    "Обновите страницу и войдите снова.",
    "Refresh the page and sign in again.",
  ],
  UNAUTHENTICATED: [
    "Войдите снова, чтобы продолжить.",
    "Sign in again to continue.",
  ],
  CSRF_INVALID: [
    "Обновите страницу и попробуйте ещё раз.",
    "Reload the page and try again.",
  ],
  INVALID_EMAIL: [
    "Проверьте адрес электронной почты.",
    "Check the email address.",
  ],
  INVALID_PASSWORD: [
    "Пароль должен содержать от 15 до 128 символов.",
    "The password must contain 15–128 characters.",
  ],
  INVALID_HANDLE: [
    "Имя пользователя: 3–24 латинские буквы, цифры или _.",
    "Use 3–24 letters, numbers or _ for your username.",
  ],
  SIGNUP_UNAVAILABLE: [
    "Этот адрес или имя пользователя уже заняты. Выберите другое имя или войдите.",
    "This email or username is taken. Choose another name or sign in.",
  ],
  TELEGRAM_AUTH_PENDING: ["Откройте бота и нажмите «Старт».", "Open the bot and press Start."],
  TELEGRAM_AUTH_INVALID: ["Проверьте код.", "Check the code."],
  TELEGRAM_AUTH_EXPIRED: ["Запросите новый код.", "Request another code."],
  AUTH_ALREADY_SIGNED_IN: ["Вы уже вошли.", "You are already signed in."],
  AUTH_BUSY: [
    "Не получилось войти. Попробуйте ещё раз.",
    "Could not sign in. Try again.",
  ],
  MAIL_UNAVAILABLE: [
    "Не удалось отправить письмо. Попробуйте ещё раз.",
    "Could not send the email. Try again.",
  ],
  ACTION_UNAVAILABLE: [
    "Это действие сейчас недоступно.",
    "This action is currently unavailable.",
  ],
  REQUEST_COOLDOWN: [
    "Повторную заявку можно отправить через сутки.",
    "You can send another request after 24 hours.",
  ],
  REQUEST_CLOSED: [
    "Эта заявка уже обработана.",
    "This request has already been handled.",
  ],
  ROOM_NOT_OPEN: [
    "Комнату уже нельзя изменить.",
    "This room can no longer be changed.",
  ],
  ROOM_LIMIT: [
    "Сначала закройте одну из ваших активных комнат.",
    "Close one of your active rooms first.",
  ],
  MATCH_ALREADY_STARTED: [
    "Партия уже началась.",
    "The game has already started.",
  ],
  BOTS_UNSUPPORTED: [
    "В этой игре пока нет ботов.",
    "This game has no bots yet.",
  ],
  FRIENDS_REQUIRED: [
    "Приглашать можно только принятых друзей.",
    "You can only invite accepted friends.",
  ],
  ALREADY_JOINED: [
    "Друг уже находится в этой комнате.",
    "Your friend is already in this room.",
  ],
  INVITATION_CLOSED: [
    "Это приглашение больше не действует. Попросите новое.",
    "This invitation is no longer valid. Ask for a new one.",
  ],
  RESERVATION_REQUIRED: [
    "Примите новое приглашение.",
    "Accept a new invitation.",
  ],
  PLAYER_COUNT: [
    "Для старта нужно больше участников.",
    "More players are needed to start.",
  ],
  PLAYERS_NOT_READY: [
    "Все участники должны подтвердить готовность.",
    "Everyone must confirm readiness.",
  ],
  RESERVATIONS_PENDING: [
    "Ждём приглашённых друзей.",
    "Waiting for invited friends.",
  ],
  MATCH_NOT_STARTED: [
    "Партия ещё не началась.",
    "The game has not started yet.",
  ],
  ALREADY_SUBMITTED: [
    "Вы уже выбрали число.",
    "You have already picked a number.",
  ],
  MATCH_FINISHED: ["Партия уже завершена.", "The game has finished."],
  STALE_PHASE: ["Этап уже сменился. Выберите действие снова.", "The phase has changed. Choose another action."],
  INSUFFICIENT_RESOURCES: ["Не хватает свободных ресурсов.", "Not enough available resources."],
  ASSET_UNAVAILABLE: ["Это имущество уже обещано в другом предложении.", "This property is held for another offer."],
  EMPTY_LOT_LIMIT: ["Можно владеть только одним пустым участком.", "You can own only one empty lot."],
  INVALID_BID: ["Проверьте участок и сумму ставки.", "Check the lot and bid amount."],
  INVALID_TRADE: ["Обе стороны должны что-то отдать. Проверьте условия.", "Both sides must give something. Check the terms."],
  INVALID_PARK: ["На парк нужно ровно 4 монеты, 1 материал и 1 бригада.", "A park needs exactly 4 coins, 1 material and 1 crew."],
  OFFER_CHANGED: ["Предложение уже изменилось или закрылось.", "This offer has changed or closed."],
  OFFER_LIMIT: ["У вас уже три открытых предложения. Закройте одно.", "You already have three open offers. Close one first."],
  PARK_UNAVAILABLE: ["На этом месте парк уже построен.", "A park has already been built here."],
  NOT_YOUR_TURN: ["Сейчас ход другого игрока.", "It is another player's turn."],
  WRONG_PHASE: ["Сейчас это действие недоступно.", "This action is not available in this phase."],
  INVALID_LOT: ["Выберите подходящий участок.", "Choose a suitable lot."],
  PLAYER_LEFT: ["Этот игрок вышел из партии.", "This player has left the game."],
  INVALID_MAP: ["Выберите другую карту.", "Choose another map."],
  INVALID_SETTINGS: ["Проверьте настройки комнаты.", "Check the room settings."],
  INVALID_INPUT: ["Проверьте заполненные поля.", "Check the form fields."],
  INTERNAL_ERROR: [
    "Не получилось. Попробуйте ещё раз.",
    "Something went wrong. Please try again.",
  ],
};

export default function App() {
  const [lang, setLang] = useState<Language>(() =>
    localStorage.getItem("iva.portal.language") === "en" ? "en" : "ru",
  );
  const t = useCallback(
    (ru: string, en: string) => (lang === "ru" ? ru : en),
    [lang],
  );
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const refreshPending = useRef<Promise<void> | null>(null);
  const refreshVersion = useRef(0);
  const sessionPlayerId = useRef<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [offline, setOffline] = useState(false);
  const [route, setRoute] = useState<Route>(readRoute);
  const [games, setGames] = useState<Game[]>([]);
  const [social, setSocial] = useState<Social>(emptySocial);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [hiddenRoomCount, setHiddenRoomCount] = useState(0);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [entrance, setEntrance] = useState(entranceAtLoad);
  const [createGame, setCreateGame] = useState<string | null>(null);
  const [inviteFriend, setInviteFriend] = useState<PublicPlayer | null>(null);
  const [gameInfo, setGameInfo] = useState<Game | null>(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<PublicPlayer[] | null>(
    null,
  );
  const user = session?.user ?? null;
  const verified = Boolean(user?.emailVerified || user?.telegramVerified);
  const cataloguePage = route.page === "home" || route.page === "chess" || route.page === "games" ? route.page : null;

  useEffect(() => {
    setCreateGame(null);
    setInviteFriend(null);
    setGameInfo(null);
    setSearchResults(null);
  }, [user?.playerId]);

  useEffect(() => {
    if (verified && new URLSearchParams(location.search).get("game") === "shift") {
      setCreateGame("shift");
      history.replaceState(null, "", location.pathname + location.hash);
    }
  }, [verified]);

  useEffect(() => {
    document.documentElement.lang = lang;
    localStorage.setItem("iva.portal.language", lang);
  }, [lang]);
  useEffect(() => {
    const listener = () => {
      setRoute(readRoute());
      setSelectedRoom(null);
      if (!/^\/(verify|reset(?:-password)?)\/?$/.test(location.pathname) || location.hash.startsWith("#/"))
        setEntrance(null);
    };
    window.addEventListener("hashchange", listener);
    window.addEventListener("popstate", listener);
    return () => {
      window.removeEventListener("hashchange", listener);
      window.removeEventListener("popstate", listener);
    };
  }, []);

  const refresh = useCallback(() => {
    const version = ++refreshVersion.current;
    const work = (async () => {
      const nextSession = await getSession();
      const gameData = await request<{ games: Game[] }>("/games");
      let friendData: Social = emptySocial;
      let roomData: { rooms: Room[]; hiddenRoomCount?: number } = { rooms: [] };
      let invitationData: { invitations: Invitation[] } = { invitations: [] };
      let telegramData: TelegramStatus | null = null;
      let nextRoom: Room | null = null;
      if (nextSession.user?.emailVerified || nextSession.user?.telegramVerified) {
        [friendData, roomData, invitationData, telegramData] =
          await Promise.all([
            request<Social>("/friends"),
            request<{ rooms: Room[]; hiddenRoomCount?: number }>("/rooms"),
            request<{ invitations: Invitation[] }>("/invitations"),
            request<TelegramStatus>("/telegram"),
          ]);
        if (route.roomId) {
          try {
            nextRoom = (
              await request<{ room: Room }>(
                `/rooms/${encodeURIComponent(route.roomId)}`,
              )
            ).room;
          } catch (error) {
            if (
              error instanceof PlatformError &&
              [403, 404].includes(error.status)
            ) {
              if (version === refreshVersion.current) go("rooms");
            } else throw error;
          }
        }
        if (
          route.invitationId &&
          !invitationData.invitations.some(
            (item) => item.invitationId === route.invitationId,
          )
        ) {
          try {
            const data = await request<{ invitation: Invitation }>(
              `/invitations/${encodeURIComponent(route.invitationId)}`,
            );
            invitationData.invitations.push(data.invitation);
          } catch (error) {
            if (
              error instanceof PlatformError &&
              [403, 404].includes(error.status)
            ) {
              if (version === refreshVersion.current) go("invitations");
            } else throw error;
          }
        }
      }
      if (version !== refreshVersion.current) return;
      const nextPlayerId = nextSession.user?.playerId ?? null;
      if (
        nextPlayerId === null ||
        (sessionPlayerId.current !== undefined &&
          sessionPlayerId.current !== nextPlayerId)
      )
        clearTelegramAttempt();
      sessionPlayerId.current = nextPlayerId;
      setSession(nextSession);
      setGames(gameData.games);
      setSocial(friendData);
      setRooms(roomData.rooms);
      setHiddenRoomCount(roomData.hiddenRoomCount ?? 0);
      setInvitations(invitationData.invitations);
      setTelegram(telegramData);
      setSelectedRoom(nextRoom);
      setOffline(false);
      setLoaded(true);
    })();
    refreshPending.current = work;
    void work
      .finally(() => {
        if (refreshPending.current === work) refreshPending.current = null;
      })
      .catch(() => {});
    return work;
  }, [route.roomId, route.invitationId]);

  useEffect(() => {
    let live = true;
    const update = () => {
      if (busyRef.current) return;
      void refresh().catch((error) => {
        if (!live) return;
        setOffline(true);
        setLoaded(true);
        if (!session)
          setNotice({
            text:
              error instanceof PlatformError && error.code === "NETWORK"
                ? t(...errorCopy.NETWORK)
                : t(
                    "Не получилось. Попробуйте ещё раз.",
                    "Something went wrong. Please try again.",
                  ),
            error: true,
          });
      });
    };
    update();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") update();
    }, 4000);
    const visible = () => {
      if (document.visibilityState === "visible") update();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
    // Session is refreshed by this polling function; it is not a dependency that restarts polling.
  }, [refresh, t]);

  const perform: Perform = async (action, success) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await refreshPending.current?.catch(() => {});
      await action();
      if (success) setNotice({ text: success, error: false });
      return true;
    } catch (error) {
      const copy =
        error instanceof PlatformError ? errorCopy[error.code] : undefined;
      setNotice({
        text: copy
          ? t(...copy)
          : t(
              "Не получилось. Попробуйте ещё раз.",
              "Something went wrong. Please try again.",
            ),
        error: true,
      });
      await refresh().catch(() => setOffline(true));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const mutate = (path: string, body: unknown = {}, success?: string) =>
    perform(async () => {
      await request(path, body);
      await refresh();
    }, success);
  const pendingCount = invitations.filter(
    (i) =>
      i.invitee.playerId === user?.playerId &&
      ["pending", "accepted"].includes(i.status) &&
      !joinedInvitation(i),
  ).length;
  const friendCount = social.incoming.length;
  const islandMatch = route.page === "rooms" && !!route.roomId && selectedRoom?.gameId === "district" &&
    (selectedRoom.state === "playing" || selectedRoom.state === "finished") && selectedRoom.rulesVersion !== DISTRICT_RULES_VERSION;
  const territorialMatch = islandMatch && selectedRoom?.rulesVersion === TERRITORY_RULES;
  const title = {
    home: "Iva Games",
    chess: t("Шахматы", "Chess"),
    games: t("Другие игры", "Other games"),
    login: t("Войти", "Sign in"),
    friends: t("Друзья", "Friends"),
    rooms: t("Мои комнаты", "My rooms"),
    invitations: t("Приглашения", "Invitations"),
    profile: t("Мой профиль", "My profile"),
  }[route.page];
  useEffect(() => {
    document.title = title === "Iva Games" ? title : `${title} — Iva Games`;
  }, [title]);
  const availableGames = games.filter((g) => g.status === "available");
  const existingFriend = (playerId: string) =>
    social.friends.some((p) => p.playerId === playerId);
  const outgoingRequest = (playerId: string) =>
    social.outgoing.find((r) => r.player.playerId === playerId);
  const incomingRequest = (playerId: string) =>
    social.incoming.find((r) => r.player.playerId === playerId);

  const socialAction = (player: PublicPlayer): ReactNode => {
    const outgoing = outgoingRequest(player.playerId);
    const incoming = incomingRequest(player.playerId);
    if (existingFriend(player.playerId))
      return (
        <span className="tag success">
          <Icon name="check" size={14} />
          {t("Уже в друзьях", "Already friends")}
        </span>
      );
    if (social.blocked.some((p) => p.playerId === player.playerId))
      return (
        <button
          className="button small secondary"
          disabled={busy}
          onClick={() =>
            void mutate(
              `/blocks/${player.playerId}/remove`,
              {},
              t("Блокировка снята.", "Player unblocked."),
            )
          }
        >
          {t("Разблокировать", "Unblock")}
        </button>
      );
    if (incoming)
      return (
        <button
          className="button small primary"
          disabled={busy}
          onClick={() =>
            void mutate(
              `/friend-requests/${incoming.requestId}/accept`,
              {},
              t("Теперь вы друзья.", "You are now friends."),
            )
          }
        >
          {t("Принять", "Accept")}
        </button>
      );
    if (outgoing)
      return (
        <button
          className="button small secondary"
          disabled={busy}
          onClick={() =>
            void mutate(`/friend-requests/${outgoing.requestId}/cancel`)
          }
        >
          {t("Отменить заявку", "Cancel request")}
        </button>
      );
    return (
      <button
        className="button small primary"
        disabled={busy || player.playerId === user?.playerId}
        onClick={() =>
          void perform(async () => {
            await request("/friend-requests", { playerId: player.playerId });
            const latest = await request<Social>("/friends");
            await refresh();
            const feedback = friendRequestFeedback(latest, player.playerId);
            setNotice({
              text: feedback === "received"
                ? t("Вам уже пришла заявка. Примите её.", "They already sent you a request. Accept it to become friends.")
                : feedback === "friends"
                  ? t("Вы уже друзья.", "You are already friends.")
                  : t("Заявка отправлена.", "Friend request sent."),
              error: false,
            });
          })
        }
      >
        <Icon name="plus" size={16} />
        {t("Добавить", "Add friend")}
      </button>
    );
  };

  return (
    <LanguageContext.Provider value={{ lang, t, setLanguage: setLang }}>
      <div className={`portal ${user && !entrance && !cataloguePage && route.page !== "login" ? "signed-in" : ""}`}>
        <div className="language-switch" aria-label={t("Язык", "Language")}>
          <button aria-pressed={lang === "ru"} onClick={() => setLang("ru")}>
            RU
          </button>
          <button aria-pressed={lang === "en"} onClick={() => setLang("en")}>
            EN
          </button>
        </div>
        {!user && !entrance && !cataloguePage && (
          <nav
            className="guest-games"
            aria-label={t("Разделы игр", "Game collections")}
          >
            <PortalLink className="button secondary small" href={chessHomeUrl}>
              {t("Шахматы", "Chess")}
            </PortalLink>
            <PortalLink className="button secondary small" href="/games">
              {t("Другие игры", "Other games")}
            </PortalLink>
          </nav>
        )}
        {user && !entrance && !cataloguePage && route.page !== "login" && (
          <a
            className="mobile-account"
            href="#/profile"
            aria-label={t("Мой профиль", "My profile")}
          >
            <Avatar player={user} />
          </a>
        )}
        {notice && (
          <div
            className={`toast ${notice.error ? "error" : "success"}`}
            role={notice.error ? "alert" : "status"}
          >
            <span>{notice.text}</span>
            <button
              className="icon-button"
              onClick={() => setNotice(null)}
              aria-label={t("Закрыть уведомление", "Dismiss notification")}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        )}
        {!loaded ? (
          <div className="loading-page">
            <Brand />
            <span className="spinner" />
            <p>{t("Загружаем…", "Loading…")}</p>
          </div>
        ) : !session ? (
          <div className="loading-page">
            <Brand />
            <Empty
              icon="rooms"
              title={t("Не получается подключиться", "Unable to connect")}
            >
              {t(
                "Проверьте соединение и попробуйте ещё раз.",
                "Check the connection and try again.",
              )}
            </Empty>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void perform(refresh)}
            >
              {t("Повторить", "Retry")}
            </button>
          </div>
        ) : cataloguePage && !entrance ? (
          <Catalogue page={cataloguePage} games={games} user={user} busy={busy} offline={offline}
            retry={() => void perform(refresh)}
            onPlay={(game) => {
              if (!user) go("rooms");
              else if (!verified) go("profile");
              else setCreateGame(game.gameId);
            }}
            onAbout={setGameInfo}
          />
        ) : !user || entrance || route.page === "login" ? (
          <Auth
            busy={busy}
            perform={perform}
            onAuthenticated={async () => {
              await refresh();
              if (readRoute().page === "login" && !entrance) go("home", undefined, true);
            }}
            auth={session?.auth}
            entrance={entrance}
            clearEntrance={() => {
              setEntrance(null);
              go(user ? "profile" : "login", undefined, true);
            }}
          />
        ) : (
          <>
            <aside className="sidebar">
              <Brand />
              <nav aria-label={t("Основное меню", "Main navigation")}>
                {(["games", "friends", "rooms", "invitations"] as const).map(
                  (page) => (
                    <a
                      key={page}
                      href={page === "games" ? "/" : `/${page}`}
                      className={`nav-item ${route.page === page ? "active" : ""}`}
                      aria-current={route.page === page ? "page" : undefined}
                    >
                      <Icon name={page === "invitations" ? "mail" : page} />
                      <span>
                        {
                          {
                            games: t("Каталог", "Games"),
                            friends: t("Друзья", "Friends"),
                            rooms: t("Комнаты", "Rooms"),
                            invitations: t("Приглашения", "Invitations"),
                          }[page]
                        }
                      </span>
                      {((page === "invitations" && pendingCount > 0) ||
                        (page === "friends" && friendCount > 0)) && (
                        <b className="nav-count">
                          {page === "friends" ? friendCount : pendingCount}
                        </b>
                      )}
                    </a>
                  ),
                )}
              </nav>
              <div className="sidebar-bottom">
                <a
                  className={`account-link ${route.page === "profile" ? "active" : ""}`}
                  href="#/profile"
                >
                  <Avatar player={user} />
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>@{user.handle}</small>
                  </span>
                  <Icon name="settings" size={18} />
                </a>
                <button
                  className="logout-button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await request("/auth/logout", {});
                      await refresh();
                    })
                  }
                >
                  <Icon name="logout" size={18} />
                  <span>{t("Выйти", "Sign out")}</span>
                </button>
              </div>
            </aside>
            <main className={`workspace ${territorialMatch ? "territorial-workspace" : islandMatch ? "district-match-workspace" : ""}`}>
              {!islandMatch && <header className="page-heading">
                <div>
                  <p className="greeting">
                    {t("Рады видеть,", "Welcome,")} {user.displayName}
                  </p>
                  <h1>{title}</h1>
                </div>
                {verified && route.page !== "profile" && (
                  <button
                    className="button primary"
                    disabled={busy || !availableGames.length}
                    onClick={() =>
                      setCreateGame(availableGames[0]?.gameId || "")
                    }
                  >
                    <Icon name="plus" size={19} />
                    <span>{t("Создать комнату", "Create room")}</span>
                  </button>
                )}
              </header>}
              {offline && (
                <div className="connection-banner" role="status">
                  <span>
                    {t(
                      "Нет связи. Попробуйте ещё раз.",
                      "No connection. Please try again.",
                    )}
                  </span>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void perform(refresh)}
                  >
                    {t("Обновить", "Refresh")}
                  </button>
                </div>
              )}
              {!verified && (
                <section className="verification-banner">
                  <span className="verification-icon">
                    <Icon name="mail" size={30} />
                  </span>
                  <div>
                    <h2>{t("Подтвердите почту", "Confirm your email")}</h2>
                    <p>
                      {t("Откройте письмо на", "Open the email sent to")}{" "}
                      <strong>{user.email}</strong>.{" "}
                      {t(
                        "После подтверждения можно добавлять друзей и создавать комнаты.",
                        "Then you can add friends and create rooms.",
                      )}
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        "/auth/resend-verification",
                        {},
                        t(
                          "Письмо отправлено. Проверьте входящие и спам.",
                          "Email sent. Check your inbox and spam folder.",
                        ),
                      )
                    }
                  >
                    {t("Отправить ещё раз", "Resend email")}
                  </button>
                </section>
              )}
              {verified && route.page === "friends" && (
                <>
                  <section className="search-section">
                    <div>
                      <h2>{t("Найдите своих", "Find your people")}</h2>
                      <p>
                        {t("Поделитесь ником", "Share your username")}{" "}
                        <strong>@{user.handle}</strong>{" "}
                        {t(
                          "или найдите друга ниже.",
                          "or find a friend below.",
                        )}
                      </p>
                    </div>
                    <form
                      className="search-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform(async () => {
                          const data = await request<{
                            players: PublicPlayer[];
                          }>(
                            `/players?handle=${encodeURIComponent(search.trim().replace(/^@/, ""))}`,
                          );
                          setSearchResults(data.players);
                        });
                      }}
                    >
                      <label className="sr-only" htmlFor="friend-search">
                        {t("Имя пользователя друга", "Friend’s username")}
                      </label>
                      <input
                        id="friend-search"
                        minLength={search.startsWith("@") ? 4 : 3}
                        maxLength={25}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t("@имя_друга", "@friend_username")}
                        required
                        autoComplete="off"
                      />
                      <button
                        className="button primary"
                        disabled={busy}
                        type="submit"
                      >
                        {t("Найти", "Find")}
                      </button>
                    </form>
                  </section>
                  {searchResults && (
                    <section className="list-section">
                      <div className="section-title">
                        <h2>{t("Результаты поиска", "Search results")}</h2>
                        <button
                          className="text-button"
                          onClick={() => setSearchResults(null)}
                        >
                          {t("Скрыть", "Hide")}
                        </button>
                      </div>
                      {searchResults.filter((p) => p.playerId !== user.playerId)
                        .length ? (
                        searchResults
                          .filter((p) => p.playerId !== user.playerId)
                          .map((player) => (
                            <PlayerRow player={player} key={player.playerId}>
                              {socialAction(player)}
                            </PlayerRow>
                          ))
                      ) : (
                        <p className="inline-empty">
                          {t(
                            "Никого не нашли. Проверьте написание имени.",
                            "No players found. Check the spelling.",
                          )}
                        </p>
                      )}
                    </section>
                  )}
                  {social.incoming.length > 0 && (
                    <section className="list-section">
                      <h2>
                        {t("Хотят дружить", "Friend requests")}{" "}
                        <span className="count-label">
                          {social.incoming.length}
                        </span>
                      </h2>
                      {social.incoming.map((item) => (
                        <PlayerRow key={item.requestId} player={item.player}>
                          <button
                            className="button small primary"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `/friend-requests/${item.requestId}/accept`,
                                {},
                                t("Теперь вы друзья.", "You are now friends."),
                              )
                            }
                          >
                            {t("Принять", "Accept")}
                          </button>
                          <button
                            className="button small secondary"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `/friend-requests/${item.requestId}/decline`,
                              )
                            }
                          >
                            {t("Отклонить", "Decline")}
                          </button>
                        </PlayerRow>
                      ))}
                    </section>
                  )}
                  <section className="list-section">
                    <h2>
                      {t("Мои друзья", "My friends")}{" "}
                      <span className="count-label">
                        {social.friends.length}
                      </span>
                    </h2>
                    {social.friends.length ? (
                      social.friends.map((player) => (
                        <PlayerRow player={player} key={player.playerId}>
                          <button
                            className="button small primary"
                            disabled={busy}
                            onClick={() => setInviteFriend(player)}
                          >
                            <Icon name="mail" size={16} />
                            {t("Пригласить", "Invite")}
                          </button>
                          <details className="row-menu">
                            <summary
                              aria-label={`${t("Действия для", "Actions for")} ${player.displayName}`}
                            >
                              •••
                            </summary>
                            <div>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void mutate(
                                    `/friends/${player.playerId}/remove`,
                                    {},
                                    t(
                                      "Друг удалён из списка.",
                                      "Friend removed.",
                                    ),
                                  )
                                }
                              >
                                {t("Удалить из друзей", "Remove friend")}
                              </button>
                              <button
                                className="danger-text"
                                disabled={busy}
                                onClick={() =>
                                  void mutate(
                                    "/blocks",
                                    { playerId: player.playerId },
                                    t("Игрок заблокирован.", "Player blocked."),
                                  )
                                }
                              >
                                {t("Заблокировать", "Block")}
                              </button>
                            </div>
                          </details>
                        </PlayerRow>
                      ))
                    ) : (
                      <Empty
                        title={t(
                          "Давайте соберём компанию",
                          "Let’s get everyone together",
                        )}
                      >
                        {t(
                          "Найдите друга по нику и отправьте заявку.",
                          "Find a friend by username and send a request.",
                        )}
                      </Empty>
                    )}
                  </section>
                  {social.outgoing.length > 0 && (
                    <section className="list-section">
                      <h2>{t("Ждём ответа", "Waiting for a response")}</h2>
                      {social.outgoing.map((item) => (
                        <PlayerRow key={item.requestId} player={item.player}>
                          <span className="muted small-copy">
                            {t("Заявка отправлена", "Request sent")}
                          </span>
                          <button
                            className="button small secondary"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `/friend-requests/${item.requestId}/cancel`,
                              )
                            }
                          >
                            {t("Отменить", "Cancel")}
                          </button>
                        </PlayerRow>
                      ))}
                    </section>
                  )}
                  {social.blocked.length > 0 && (
                    <details className="blocked-section">
                      <summary>
                        {t("Заблокированные игроки", "Blocked players")} (
                        {social.blocked.length})
                      </summary>
                      {social.blocked.map((player) => (
                        <PlayerRow player={player} key={player.playerId}>
                          <button
                            className="button small secondary"
                            disabled={busy}
                            onClick={() =>
                              void mutate(`/blocks/${player.playerId}/remove`)
                            }
                          >
                            {t("Разблокировать", "Unblock")}
                          </button>
                        </PlayerRow>
                      ))}
                    </details>
                  )}
                </>
              )}
              {verified &&
                route.page === "rooms" &&
                (route.roomId ? (
                  selectedRoom ? (
                    <RoomDetail
                      room={selectedRoom}
                      user={user}
                      games={games}
                      friends={social.friends}
                      invitations={invitations}
                      busy={busy}
                      mutate={mutate}
                      perform={perform}
                      refresh={refresh}
                    />
                  ) : (
                    <div className="loading-section">
                      <span className="spinner" />
                      <p>{t("Открываем комнату…", "Opening room…")}</p>
                      <button
                        className="text-button"
                        onClick={() => go("rooms")}
                      >
                        {t("К списку комнат", "Back to rooms")}
                      </button>
                    </div>
                  )
                ) : (
                  <section className="rooms-section">
                    {(rooms.some((room) => room.state === "finished" || room.state === "cancelled") || hiddenRoomCount > 0) && (
                      <div className="room-list-tools">
                        {rooms.some((room) => room.state === "finished" || room.state === "cancelled") && (
                          <button className="button secondary small" disabled={busy} onClick={() => void mutate("/rooms/history/clear", {})}>
                            {t("Очистить завершённые", "Clear finished rooms")}
                          </button>
                        )}
                        {hiddenRoomCount > 0 && (
                          <button className="button secondary small" disabled={busy} onClick={() => void mutate("/rooms/history/restore", {})}>
                            {t("Показать завершённые", "Show finished rooms")}
                          </button>
                        )}
                      </div>
                    )}
                    {rooms.length ? (
                      <div className="room-list">
                        {rooms.map((room) => (
                          <button
                            className="room-summary"
                            key={room.roomId}
                            onClick={() => go("rooms", room.roomId)}
                          >
                            <span className={`room-game-icon ${room.gameId}`}>
                              <Icon name="rooms" size={26} />
                            </span>
                            <span className="room-summary-copy">
                              <strong>{room.title}</strong>
                              <small>
                                {games.find((g) => g.gameId === room.gameId)
                                  ? gameTitle(
                                      games.find(
                                        (g) => g.gameId === room.gameId,
                                      )!,
                                      lang,
                                    )
                                  : room.gameId}
                              </small>
                            </span>
                            <span className="room-people">
                              {room.members.length}/{room.capacity}
                            </span>
                            <StateBadge state={room.state} />
                            <Icon name="arrow" size={20} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        icon="rooms"
                        title={t(
                          "Ваш стол пока свободен",
                          "Your table is waiting",
                        )}
                        action={
                          <button
                            className="button primary"
                            disabled={busy || !availableGames.length}
                            onClick={() =>
                              setCreateGame(availableGames[0]?.gameId || "")
                            }
                          >
                            <Icon name="plus" size={18} />
                            {t(
                              "Создать первую комнату",
                              "Create your first room",
                            )}
                          </button>
                        }
                      >
                        {t(
                          "Выберите игру, пригласите друзей и начинайте, когда все готовы.",
                          "Choose a game, invite friends, and start when everyone is ready.",
                        )}
                      </Empty>
                    )}
                  </section>
                ))}
              {verified && route.page === "invitations" && (
                <Invitations
                  user={user}
                  invitations={invitations}
                  focusedId={route.invitationId}
                  busy={busy}
                  mutate={mutate}
                  perform={perform}
                  refresh={refresh}
                />
              )}
              {route.page === "profile" && (
                <Profile
                  key={user.playerId}
                  user={user}
                  telegram={telegram}
                  onTelegramChange={setTelegram}
                  busy={busy}
                  mutate={mutate}
                  perform={perform}
                  refresh={refresh}
                />
              )}
              {!verified &&
                !cataloguePage &&
                route.page !== "profile" && (
                  <Empty
                    icon="mail"
                    title={t(
                      "Продолжим после подтверждения",
                      "Continue after confirming your email",
                    )}
                  >
                    {t(
                      "Откройте письмо и подтвердите адрес.",
                      "Open the email and confirm your address.",
                    )}
                  </Empty>
                )}
            </main>
          </>
        )}
        {createGame !== null && (
          <CreateRoom
            games={availableGames}
            initialGame={createGame}
            busy={busy}
            close={() => setCreateGame(null)}
            create={(body) =>
              perform(async () => {
                const data = await request<{ room: Room }>("/rooms", body);
                setCreateGame(null);
                await refresh();
                go("rooms", data.room.roomId);
              })
            }
          />
        )}
        {inviteFriend && (
          <Modal
            title={`${t("Пригласить", "Invite")} ${inviteFriend.displayName}`}
            onClose={() => setInviteFriend(null)}
          >
            <p className="muted">
              {t(
                "Выберите комнату для приглашения.",
                "Choose a room to invite them to.",
              )}
            </p>
            {rooms.filter(
              (room) =>
                room.hostPlayerId === user?.playerId && room.state === "lobby",
            ).length ? (
              <div className="choice-list">
                {rooms
                  .filter(
                    (room) =>
                      room.hostPlayerId === user?.playerId &&
                      room.state === "lobby",
                  )
                  .map((room) => (
                    <button
                      key={room.roomId}
                      className="room-choice"
                      disabled={
                        busy ||
                        room.members.some(
                          (m) => m.playerId === inviteFriend.playerId,
                        )
                      }
                      onClick={() =>
                        void perform(
                          async () => {
                            await request(`/rooms/${room.roomId}/invitations`, {
                              playerId: inviteFriend.playerId,
                            });
                            setInviteFriend(null);
                            await refresh();
                          },
                          t("Приглашение отправлено.", "Invitation sent."),
                        )
                      }
                    >
                      <span>
                        <strong>{room.title}</strong>
                        <small>
                          {room.members.length}/{room.capacity}{" "}
                          {t("мест", "seats")}
                        </small>
                      </span>
                      <Icon name="mail" />
                    </button>
                  ))}
              </div>
            ) : (
              <Empty
                icon="rooms"
                title={t("Сначала создайте комнату", "Create a room first")}
                action={
                  <button
                    className="button primary"
                    onClick={() => {
                      setInviteFriend(null);
                      setCreateGame(availableGames[0]?.gameId || "");
                    }}
                  >
                    {t("Создать комнату", "Create room")}
                  </button>
                }
              >
                {t(
                  "Из своей комнаты можно приглашать друзей.",
                  "You can invite friends from a room you host.",
                )}
              </Empty>
            )}
          </Modal>
        )}
        {gameInfo && (
          <Modal
            title={gameTitle(gameInfo, lang)}
            onClose={() => setGameInfo(null)}
          >
            <GameArt kind={gameInfo.gameId} />
            <p>{gameDescription(gameInfo.gameId, lang)}</p>
            <p className="muted">{t("Скоро здесь", "Coming soon")}</p>
          </Modal>
        )}
      </div>
    </LanguageContext.Provider>
  );
}

function PlayerRow({
  player,
  children,
}: {
  player: PublicPlayer;
  children: ReactNode;
}) {
  return (
    <div className="player-row">
      <Avatar player={player} />
      <div className="player-name">
        <strong>{player.displayName}</strong>
        <small>@{player.handle}</small>
      </div>
      <div className="player-actions">{children}</div>
    </div>
  );
}

function StateBadge({ state }: { state: Room["state"] }) {
  const { t } = useLanguage();
  return (
    <span className={`tag state-${state}`}>
      {
        {
          lobby: t("Собираемся", "Gathering"),
          starting: t("Запускаем", "Starting"),
          playing: t("Идёт игра", "Playing"),
          finished: t("Завершена", "Finished"),
          cancelled: t("Отменена", "Cancelled"),
        }[state]
      }
    </span>
  );
}


function CreateRoom({
  games,
  initialGame,
  busy,
  close,
  create,
}: {
  games: Game[];
  initialGame: string;
  busy: boolean;
  close: () => void;
  create: (body: {
    gameId: string;
    capacity: number;
    title: string;
    settings?: Record<string, unknown>;
  }) => Promise<boolean>;
}) {
  const { t, lang } = useLanguage();
  const [gameId, setGameId] = useState(initialGame || games[0]?.gameId || "");
  const game = games.find((item) => item.gameId === gameId);
  const [capacity, setCapacity] = useState(Math.min(game?.maxPlayers || 4, 4));
  const [title, setTitle] = useState("");
  const [districtMap, setDistrictMap] = useState<DistrictMap>(DISTRICT_ISLAND_MAPS[0]);
  const [territorialMap, setTerritorialMap] = useState(territoryMaps[0]);
  const [preset, setPreset] = useState(districtPreset(undefined));
  const [shiftArena, setShiftArena] = useState("foundry");
  const [shiftRotate, setShiftRotate] = useState(true);
  const territorial = game?.rulesVersion === TERRITORY_RULES;
  return (
    <Modal title={t("Новая комната", "New room")} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create({
            gameId,
            capacity,
            title: title.trim() || t("Играем вместе", "Playing together"),
            ...(gameId === "district" ? {
              settings: territorial ? { mapId: territorialMap.id, mapVersion: territorialMap.version, newsPreset: preset } :
                { mapId: districtMap.id, mapVersion: districtMap.version },
            } : gameId === "shift" ? { settings: { arena: shiftArena, teamSize: capacity / 2, rotateRoles: shiftRotate, difficulty: "normal" } } : {}),
          });
        }}
      >
        <label>
          {t("Игра", "Game")}
          <select
            value={gameId}
            onChange={(event) => {
              const next = games.find((g) => g.gameId === event.target.value)!;
              setGameId(next.gameId);
              setCapacity(Math.min(next.maxPlayers, 4));
            }}
          >
            {games.map((item) => (
              <option key={item.gameId} value={item.gameId}>
                {gameTitle(item, lang)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Название комнаты", "Room name")}
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={60}
            placeholder={t("Играем вместе", "Playing together")}
          />
        </label>
        <label>
          {t("Мест за столом", "Seats at the table")}
          <select
            value={capacity}
            onChange={(event) => setCapacity(Number(event.target.value))}
          >
            {(gameId === "shift" ? [4, 6] : Array.from(
              {
                length: Math.max(
                  0,
                  (game?.maxPlayers || 0) - (game?.minPlayers || 0) + 1,
                ),
              },
              (_, i) => (game?.minPlayers || 2) + i,
            )).map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
        {gameId === "district" && (territorial
          ? <TerritorialSettingsFields map={territorialMap} setMap={setTerritorialMap} preset={preset} setPreset={setPreset} />
          : <DistrictMapSelect value={districtMap.id} version={districtMap.version} onChange={setDistrictMap} />)}
        {gameId === "shift" && <><label>{t("Арена", "Arena")}<select value={shiftArena} onChange={e => setShiftArena(e.target.value)}><option value="foundry">{t("Крановый цех", "Crane foundry")}</option><option value="calibration">{t("Калибровка", "Calibration")}</option><option value="depot">{t("Склад модулей", "Module depot")}</option></select></label><label><input type="checkbox" checked={shiftRotate} onChange={e => setShiftRotate(e.target.checked)} /> {t("Смена ролей по раундам", "Rotate roles each round")}</label></>}
        <p className="form-note">
          <Icon name="lock" size={17} />
          {gameId === "district"
            ? t(
              "Комната закрытая. После создания добавьте ботов или пригласите друзей.",
              "This room is private. Add bots or invite friends after creating it.",
            )
            : t(
              "В комнату войдут только приглашённые друзья.",
              "Only invited friends can join your room.",
            )}
        </p>
        <button
          className="button primary wide"
          disabled={busy || !game}
          type="submit"
        >
          {t("Создать комнату", "Create room")}
        </button>
      </form>
    </Modal>
  );
}

type Mutation = (
  path: string,
  body?: unknown,
  success?: string,
) => Promise<boolean>;

function RoomDetail({
  room,
  user,
  games,
  friends,
  invitations,
  busy,
  mutate,
  perform,
  refresh,
}: {
  room: Room;
  user: User;
  games: Game[];
  friends: PublicPlayer[];
  invitations: Invitation[];
  busy: boolean;
  mutate: Mutation;
  perform: Perform;
  refresh: () => Promise<void>;
}) {
  const { t, lang } = useLanguage();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [difficulty, setDifficulty] = useState<BotDifficulty>("normal");
  const host = user.playerId === room.hostPlayerId;
  const self = room.members.find((member) => member.playerId === user.playerId);
  const game = games.find((item) => item.gameId === room.gameId);
  const canStart =
    room.state === "lobby" &&
    room.members.length >= (game?.minPlayers || 2) &&
    room.members.every((member) => member.ready) &&
    room.reservedSeats === 0;
  const freeSeats = room.capacity - room.members.length - room.reservedSeats;
  const lobby = room.state === "lobby";
  const roomInvites = invitations.filter(
    (invite) =>
      invite.roomId === room.roomId &&
      ["pending", "accepted"].includes(invite.status) &&
      !joinedInvitation(invite),
  );
  if (room.gameId === "shift") return <Suspense fallback={<span className="spinner" />}><ShiftRoom room={room} user={user} friends={friends} invitations={invitations} busy={busy} perform={perform} refresh={refresh} /></Suspense>;
  if (room.rulesVersion === TERRITORY_RULES && room.matchId && ["playing", "finished"].includes(room.state)) {
    return <Suspense fallback={<span className="spinner" />}><TerritorialMatch key={room.matchId} room={room} refresh={refresh} /></Suspense>;
  }
  return (
    <section className="room-detail">
      <button className="back-link" onClick={() => go("rooms")}>
        ‹ {t("Мои комнаты", "My rooms")}
      </button>
      <div className="room-heading">
        <div>
          <h2>{room.title}</h2>
          <p>
            {game ? gameTitle(game, lang) : room.gameId}{" "}
            <span className="separator">/</span> {room.members.length}/
            {room.capacity} {t("участников", "players")}
          </p>
        </div>
        <StateBadge state={room.state} />
        {host && lobby && (
          <button
            className="icon-button room-settings"
            aria-label={t("Настройки комнаты", "Room settings")}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" />
          </button>
        )}
      </div>
      {lobby && room.gameId === "district" && (room.rulesVersion === TERRITORY_RULES
        ? <TerritorialLobby room={room} />
        : <DistrictLobbyMap rulesVersion={room.rulesVersion} mapId={room.settings.mapId} mapVersion={room.settings.mapVersion} />)}
      <div className={`room-columns ${room.gameId === "district" && !lobby ? "district-playing-seats" : ""}`}>
        <div className="seats-panel">
          <div className="section-title">
            <h3>{t("За столом", "At the table")}</h3>
            {host && lobby && (
              <button
                className="button small secondary"
                disabled={busy || freeSeats <= 0}
                onClick={() => setInviteOpen(true)}
              >
                <Icon name="plus" size={17} />
                {t("Пригласить", "Invite")}
              </button>
            )}
          </div>
          {room.members.map((member) => (
            <div
              className={`seat-row ${member.playerId === user.playerId ? "your-seat" : ""}`}
              key={member.participantId}
            >
              <span className="seat-number">{member.seatIndex + 1}</span>
              <Avatar player={member} bot={member.controller.kind === "bot"} />
              <div className="player-name">
                <strong>
                  {room.gameId === "district" && member.controller.kind === "bot" ? districtBotName(member.seatIndex, lang) : member.displayName}
                  {member.playerId === user.playerId && (
                    <span className="you-label">{t("вы", "you")}</span>
                  )}
                </strong>
                <small>
                  {member.controller.kind === "bot"
                    ? `${t("Бот", "Bot")} / ${difficultyLabel(member.controller.difficulty, lang, room.gameId)}`
                    : member.playerId === room.hostPlayerId
                      ? t("Хозяин комнаты", "Room host")
                      : `@${member.handle}`}
                </small>
              </div>
              <span
                className={`ready-status ${member.ready ? "is-ready" : ""}`}
              >
                {member.ready ? (
                  <>
                    <Icon name="check" size={16} />
                    {t("Готов", "Ready")}
                  </>
                ) : (
                  t("Не готов", "Not ready")
                )}
              </span>
              {host && lobby && member.playerId !== user.playerId && (
                <details className="row-menu">
                  <summary
                    aria-label={`${t("Действия для", "Actions for")} ${member.displayName}`}
                  >
                    •••
                  </summary>
                  <div>
                    {member.controller.kind === "human" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void mutate(`/rooms/${room.roomId}/transfer-host`, {
                            playerId: member.playerId,
                            expectedRevision: room.revision,
                          })
                        }
                      >
                        {t("Передать комнату", "Make host")}
                      </button>
                    )}
                    <button
                      className="danger-text"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          member.controller.kind === "bot"
                            ? `/rooms/${room.roomId}/bots/${member.participantId}/remove`
                            : `/rooms/${room.roomId}/kick`,
                          member.controller.kind === "bot"
                            ? { expectedRevision: room.revision }
                            : {
                                participantId: member.participantId,
                                expectedRevision: room.revision,
                              },
                        )
                      }
                    >
                      {member.controller.kind === "bot"
                        ? t("Убрать бота", "Remove bot")
                        : t("Убрать из комнаты", "Remove player")}
                    </button>
                  </div>
                </details>
              )}
            </div>
          ))}
          {Array.from({ length: Math.max(0, room.reservedSeats) }, (_, i) => (
            <div className="seat-row vacant reserved" key={`reserved-${i}`}>
              <span className="vacant-symbol">
                <Icon name="mail" size={21} />
              </span>
              <div>
                <strong>{t("Место забронировано", "Seat reserved")}</strong>
                <small>
                  {t(
                    "Друг принял приглашение и скоро присоединится",
                    "Your friend accepted and can now join",
                  )}
                </small>
              </div>
            </div>
          ))}
          {Array.from({ length: Math.max(0, freeSeats) }, (_, i) => (
            <div className="seat-row vacant" key={`free-${i}`}>
              <span className="vacant-symbol">
                <Icon name="plus" size={21} />
              </span>
              <span>{t("Свободное место", "Open seat")}</span>
            </div>
          ))}
          {host && lobby && game?.supportsBots && (
            <div className="add-bot">
              <div>
                <Icon name="robot" size={20} />
                <span>{t("Добавить бота", "Add a bot")}</span>
              </div>
              <label className="sr-only" htmlFor="bot-difficulty">
                {t("Сложность бота", "Bot difficulty")}
              </label>
              <select
                id="bot-difficulty"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as BotDifficulty)}
                disabled={busy || freeSeats <= 0}
              >
                {(["easy", "normal", "hard"] as const).map((level) => (
                  <option key={level} value={level}>
                    {difficultyLabel(level, lang, room.gameId)}
                  </option>
                ))}
              </select>
              <button
                className="button small secondary"
                disabled={busy || freeSeats <= 0}
                onClick={() =>
                  void mutate(`/rooms/${room.roomId}/bots`, {
                    difficulty,
                    expectedRevision: room.revision,
                  })
                }
              >
                {t("Добавить", "Add")}
              </button>
            </div>
          )}
        </div>
        <aside className="table-panel">
          <div className="table-illustration" aria-hidden="true">
            <span className="table-top" />
            <span className="table-piece piece-a" />
            <span className="table-piece piece-b" />
            <span className="table-card" />
            <span className="table-die">
              <Icon name="games" size={32} />
            </span>
          </div>
          <h3>
            {lobby
              ? t("Собираемся на игру", "Gathering for a game")
              : room.state === "starting"
                ? t("Подготавливаем партию", "Preparing your game")
                : room.state === "playing"
                  ? t("Игра уже началась", "The game has started")
                  : t("Этот стол завершён", "This table is finished")}
          </h3>
          <p>
            {lobby
              ? t(
                  "Нажмите «Я готов», когда можно начинать.",
                  "Press “I’m ready” when you are ready to start.",
                )
              : room.state === "starting"
                ? t("Скоро начнём…", "Starting soon…")
                : room.state === "playing"
                  ? t("Партия идёт.", "The game is in progress.")
                  : t(
                      "Чтобы сыграть ещё раз, создайте новую комнату.",
                      "Create a new room to play again.",
                    )}
          </p>
          {lobby && self && (
            <button
              className={`button wide ${self.ready ? "secondary" : "teal"}`}
              disabled={busy}
              onClick={() =>
                void mutate(`/rooms/${room.roomId}/ready`, {
                  ready: !self.ready,
                  expectedRevision: room.revision,
                })
              }
            >
              <Icon name="check" size={19} />
              {self.ready
                ? t("Пока не готов", "Not ready yet")
                : t("Я готов", "I’m ready")}
            </button>
          )}
          {host && lobby && (
            <>
              <button
                className="button primary wide"
                disabled={busy || !canStart}
                onClick={() =>
                  void mutate(`/rooms/${room.roomId}/start`, {
                    expectedRevision: room.revision,
                  })
                }
              >
                {t("Начать игру", "Start game")}
              </button>
              {!canStart && (
                <small className="start-hint">
                  {room.reservedSeats > 0
                    ? t(
                        "Дождитесь входа приглашённых друзей.",
                        "Wait for invited friends to join.",
                      )
                    : room.members.length < (game?.minPlayers || 2)
                      ? t(
                          "Нужно больше участников. Пригласите друга или добавьте бота.",
                          "More players are needed. Invite a friend or add a bot.",
                        )
                      : t(
                          "Ждём готовности всех участников.",
                          "Waiting for everyone to be ready.",
                        )}
                </small>
              )}
            </>
          )}
          {lobby && (
            <button
              className="text-button danger-text leave-button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await request(
                    `/rooms/${room.roomId}/${host ? "cancel" : "leave"}`,
                    {},
                  );
                  go("rooms");
                  await refresh();
                })
              }
            >
              {host
                ? t("Закрыть комнату", "Close room")
                : t("Покинуть комнату", "Leave room")}
            </button>
          )}
        </aside>
      </div>
      {["playing", "finished"].includes(room.state) && room.matchId && (
        room.gameId === "district" ? <DistrictPanel key={room.matchId} room={room} busy={busy} perform={perform} refresh={refresh} /> : <MatchPanel room={room} busy={busy} perform={perform} refresh={refresh} />
      )}{" "}
      {host && lobby && roomInvites.length > 0 && (
        <section className="list-section room-invite-list">
          <h3>{t("Приглашения в эту комнату", "Invitations to this room")}</h3>
          {roomInvites.map((invite) => (
            <PlayerRow key={invite.invitationId} player={invite.invitee}>
              <InvitationBadge invite={invite} />
              <button
                className="button small secondary"
                disabled={busy}
                onClick={() =>
                  void mutate(`/invitations/${invite.invitationId}/revoke`)
                }
              >
                {t("Отозвать", "Revoke")}
              </button>
            </PlayerRow>
          ))}
        </section>
      )}
      {settingsOpen && game && (
        <RoomSettings
          room={room}
          game={game}
          busy={busy}
          close={() => setSettingsOpen(false)}
          save={(body) =>
            perform(async () => {
              await request(`/rooms/${room.roomId}/settings`, body);
              setSettingsOpen(false);
              await refresh();
            })
          }
        />
      )}{" "}
      {inviteOpen && (
        <Modal
          title={t("Пригласить друзей", "Invite friends")}
          onClose={() => setInviteOpen(false)}
        >
          <p className="muted">
            {t("Выберите, кого позвать.", "Choose who to invite.")}
          </p>
          {friends.filter(
            (friend) =>
              !room.members.some(
                (member) => member.playerId === friend.playerId,
              ),
          ).length ? (
            friends
              .filter(
                (friend) =>
                  !room.members.some(
                    (member) => member.playerId === friend.playerId,
                  ),
              )
              .map((friend) => {
                const existing = roomInvites.find(
                  (invite) => invite.invitee.playerId === friend.playerId,
                );
                return (
                  <PlayerRow key={friend.playerId} player={friend}>
                    {existing ? (
                      <InvitationBadge invite={existing} />
                    ) : (
                      <button
                        className="button primary small"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/rooms/${room.roomId}/invitations`,
                            { playerId: friend.playerId },
                            t("Приглашение отправлено.", "Invitation sent."),
                          )
                        }
                      >
                        {t("Пригласить", "Invite")}
                      </button>
                    )}
                  </PlayerRow>
                );
              })
          ) : (
            <Empty
              title={t("Пока некого пригласить", "No one to invite yet")}
              action={
                <button
                  className="button secondary"
                  onClick={() => {
                    setInviteOpen(false);
                    go("friends");
                  }}
                >
                  {t("Открыть друзей", "Open friends")}
                </button>
              }
            >
              {t(
                "Добавьте друзей или подождите, пока они примут заявку.",
                "Add friends or wait for them to accept your request.",
              )}
            </Empty>
          )}
        </Modal>
      )}
    </section>
  );
}

function difficultyLabel(value: BotDifficulty, lang: Language, gameId?: string) {
  if (gameId === "district") return { easy: ["Новичок", "Beginner"], normal: ["Обычный", "Normal"], hard: ["Опытный", "Experienced"] }[value][lang === "ru" ? 0 : 1];
  return {
    easy: ["Лёгкий", "Easy"],
    normal: ["Обычный", "Normal"],
    hard: ["Сложный", "Hard"],
  }[value][lang === "ru" ? 0 : 1];
}
function RoomSettings({
  room,
  game,
  busy,
  close,
  save,
}: {
  room: Room;
  game: Game;
  busy: boolean;
  close: () => void;
  save: (body: unknown) => Promise<boolean>;
}) {
  const { t } = useLanguage();
  const [title, setTitle] = useState(room.title);
  const [capacity, setCapacity] = useState(room.capacity);
  const territorial = room.rulesVersion === TERRITORY_RULES;
  const [territorialMap, setTerritorialMap] = useState(territoryMaps.find(item => item.id === room.settings.mapId) ?? territoryMaps[0]);
  const [preset, setPreset] = useState(districtPreset(room.settings.newsPreset));
  const [districtMap, setDistrictMap] = useState(DISTRICT_MAP_CATALOG.find(map => map.id === room.settings.mapId && (room.settings.mapVersion === undefined || map.version === room.settings.mapVersion)) ?? (room.rulesVersion === DISTRICT_RULES_VERSION ? DISTRICT_MAPS[0] : DISTRICT_ISLAND_MAPS[0]));
  return (
    <Modal title={t("Настройки комнаты", "Room settings")} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save({ title, capacity, expectedRevision: room.revision, ...(room.gameId === "district" ? {
            settings: territorial ? { mapId: territorialMap.id, mapVersion: territorialMap.version, newsPreset: preset } :
              { mapId: districtMap.id, mapVersion: districtMap.version },
          } : {}) });
        }}
      >
        <label>
          {t("Название", "Name")}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            required
          />
        </label>
        <label>
          {t("Мест за столом", "Seats at the table")}
          <select
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
          >
            {Array.from(
              { length: game.maxPlayers - game.minPlayers + 1 },
              (_, i) => game.minPlayers + i,
            ).map((value) => (
              <option
                value={value}
                key={value}
                disabled={value < room.members.length + room.reservedSeats}
              >
                {value}
              </option>
            ))}
          </select>
        </label>
        {room.gameId === "district" && (territorial
          ? <TerritorialSettingsFields map={territorialMap} setMap={setTerritorialMap} preset={preset} setPreset={setPreset} />
          : <DistrictMapSelect value={districtMap.id} version={districtMap.version} onChange={setDistrictMap} />)}
        <p className="form-note">
          {t(
            "После сохранения снова нажмите «Я готов».",
            "Press “I’m ready” again after saving.",
          )}
        </p>
        <button className="button primary wide" disabled={busy}>
          {t("Сохранить", "Save")}
        </button>
      </form>
    </Modal>
  );
}

function joinedInvitation(invite: Invitation): boolean {
  return invite.status === "accepted" && invite.reservationExpiresAt === null;
}

function InvitationBadge({ invite }: { invite: Invitation }) {
  const { t } = useLanguage();
  return (
    <span
      className={`tag ${invite.displayStatus === "accepted" ? "success" : ""}`}
    >
      {
        {
          pending: t("Ждём ответа", "Awaiting response"),
          accepted: joinedInvitation(invite)
            ? t("Уже в комнате", "Joined room")
            : t("Место забронировано", "Seat reserved"),
          declined: t("Отклонено", "Declined"),
          revoked: t("Отозвано", "Revoked"),
          expired: t("Истекло", "Expired"),
          full: t("Нет свободных мест", "Room full"),
        }[invite.displayStatus]
      }
    </span>
  );
}

function Invitations({
  user,
  invitations,
  focusedId,
  busy,
  mutate,
  perform,
  refresh,
}: {
  user: User;
  invitations: Invitation[];
  focusedId?: string;
  busy: boolean;
  mutate: Mutation;
  perform: Perform;
  refresh: () => Promise<void>;
}) {
  const { t, lang } = useLanguage();
  const incoming = invitations
    .filter((item) => item.invitee.playerId === user.playerId)
    .sort(
      (a, b) =>
        Number(b.invitationId === focusedId) -
          Number(a.invitationId === focusedId) || b.expiresAt - a.expiresAt,
    );
  const outgoing = invitations.filter(
    (item) => item.inviter.playerId === user.playerId,
  );
  const [tab, setTab] = useState<"incoming" | "outgoing">("incoming");
  const visible = tab === "incoming" ? incoming : outgoing;
  return (
    <section>
      <div
        className="segmented-tabs"
        aria-label={t("Приглашения", "Invitations")}
      >
        <button
          aria-pressed={tab === "incoming"}
          onClick={() => setTab("incoming")}
        >
          {t("Входящие", "Received")} <span>{incoming.length}</span>
        </button>
        <button
          aria-pressed={tab === "outgoing"}
          onClick={() => setTab("outgoing")}
        >
          {t("Отправленные", "Sent")} <span>{outgoing.length}</span>
        </button>
      </div>
      {visible.length ? (
        <div className="invitation-list">
          {visible.map((invite) => (
            <article
              className={`invitation-card ${focusedId === invite.invitationId ? "focused" : ""}`}
              key={invite.invitationId}
            >
              <div className="invitation-header">
                <Avatar
                  player={tab === "incoming" ? invite.inviter : invite.invitee}
                />
                <div>
                  <h3>{invite.roomTitle}</h3>
                  <p>
                    {tab === "incoming"
                      ? `${invite.inviter.displayName} ${t("приглашает вас", "invited you")}`
                      : `${t("Для", "For")} ${invite.invitee.displayName}`}
                  </p>
                </div>
                <InvitationBadge invite={invite} />
              </div>
              <div className="invitation-bottom">
                <small>
                  {joinedInvitation(invite)
                    ? t("Приглашение принято", "Invitation accepted")
                    : invite.status === "accepted" &&
                        invite.reservationExpiresAt
                      ? `${t("Место ждёт до", "Seat reserved until")} ${new Date(invite.reservationExpiresAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}`
                      : `${t("Действует до", "Expires at")} ${new Date(invite.expiresAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}`}
                </small>
                <div className="button-group">
                  {tab === "incoming" && invite.status === "pending" && (
                    <>
                      <button
                        className="button small secondary"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/invitations/${invite.invitationId}/decline`,
                          )
                        }
                      >
                        {t("Отклонить", "Decline")}
                      </button>
                      <button
                        className="button small primary"
                        disabled={busy || invite.displayStatus === "full"}
                        onClick={() =>
                          void mutate(
                            `/invitations/${invite.invitationId}/accept`,
                            {},
                            t(
                              "Приглашение принято. Войдите в комнату.",
                              "Invitation accepted. Join the room.",
                            ),
                          )
                        }
                      >
                        {t("Принять", "Accept")}
                      </button>
                    </>
                  )}
                  {tab === "incoming" && invite.status === "accepted" && (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await request(`/rooms/${invite.roomId}/join`, {});
                          await refresh();
                          go("rooms", invite.roomId);
                        })
                      }
                    >
                      {joinedInvitation(invite)
                        ? t("Открыть комнату", "Open room")
                        : t("Войти в комнату", "Join room")}
                      <Icon name="arrow" size={18} />
                    </button>
                  )}
                  {tab === "outgoing" &&
                    ["pending", "accepted"].includes(invite.status) &&
                    !joinedInvitation(invite) && (
                      <button
                        className="button small secondary"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/invitations/${invite.invitationId}/revoke`,
                          )
                        }
                      >
                        {t("Отозвать", "Revoke")}
                      </button>
                    )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon="mail"
          title={t("Здесь будут приглашения", "Invitations will appear here")}
        >
          {t(
            "Создайте комнату и позовите друзей или дождитесь их приглашения.",
            "Create a room and invite friends, or wait for their invitation.",
          )}
        </Empty>
      )}
    </section>
  );
}

function Profile({
  user,
  telegram,
  onTelegramChange,
  busy,
  mutate,
  perform,
  refresh,
}: {
  user: User;
  telegram: TelegramStatus | null;
  onTelegramChange: (status: TelegramStatus) => void;
  busy: boolean;
  mutate: Mutation;
  perform: Perform;
  refresh: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState(user.displayName);
  const [avatar, setAvatar] = useState<AvatarChoice | "">(user.avatar ?? "");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoProcessing, setPhotoProcessing] = useState(false);
  const [password, setPassword] = useState("");
  return (
    <div className="profile-grid">
      <section className="profile-card">
        <div className="profile-identity">
          <Avatar player={{ ...user, displayName: name || user.displayName, avatar: avatar || undefined }} large photoPreview={photo ?? undefined} />
          <div>
            <h2>{user.displayName}</h2>
            <p>@{user.handle}</p>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              "/profile",
              { displayName: name, avatar: avatar || null, ...(avatar === "photo" && photo ? { avatarPhoto: photo } : {}) },
              t("Профиль сохранён.", "Profile saved."),
            ).then(saved => { if (saved) setPhoto(null); });
          }}
        >
          <label>
            {t("Как вас называть", "Display name")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              required
            />
          </label>
          <AvatarPicker user={user} avatar={avatar} photo={photo} choose={setAvatar}
            choosePhoto={value => { setPhoto(value); setAvatar("photo"); }} onProcessing={setPhotoProcessing}/>
          {user.telegramVerified ? (
            <div className="profile-email">
              <span>Telegram</span>
              <span className="tag success">{t("Подтверждён", "Verified")}</span>
            </div>
          ) : <div className="profile-email">
            <span>{t("Почта", "Email")}</span>
            <strong>{user.email}</strong>
            <span className={`tag ${user.emailVerified ? "success" : ""}`}>
              {user.emailVerified
                ? t("Подтверждена", "Confirmed")
                : t("Ждёт подтверждения", "Awaiting confirmation")}
            </span>
          </div>}
          <button
            className="button primary"
            disabled={busy || photoProcessing || !name.trim() || (!photo && name.trim() === user.displayName && avatar === (user.avatar ?? ""))}
          >
            {t("Сохранить профиль", "Save profile")}
          </button>
        </form>
      </section>
      {!user.telegramVerified && <TelegramPanel
        status={telegram}
        verified={user.emailVerified}
        busy={busy}
        perform={perform}
        onStatusChange={onTelegramChange}
      />}
      <section className="profile-card security-card">
        <h2>{t("Доступ к аккаунту", "Account access")}</h2>
        {user.telegramVerified ? <p>{t("Для входа на другом устройстве запросите новый код в Telegram.", "Request a new Telegram code to sign in on another device.")}</p> : <>
        <p>
          {t(
            "Можно сменить пароль через письмо или завершить вход на всех устройствах.",
            "Reset your password by email or sign out on every device.",
          )}
        </p>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void mutate(
              "/auth/forgot-password",
              { email: user.email },
              t(
                "Инструкция отправлена на вашу почту.",
                "Recovery instructions sent to your email.",
              ),
            )
          }
        >
          {t("Сменить пароль", "Change password")}
        </button>
        <form
          className="revoke-form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(
              async () => {
                await request("/auth/revoke-sessions", { password });
                setPassword("");
                await refresh();
              },
              t("Вы вышли на всех устройствах.", "Signed out on every device."),
            );
          }}
        >
          <label>
            {t("Текущий пароль", "Current password")}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              maxLength={512}
            />
          </label>
          <button className="button secondary danger-text" disabled={busy}>
            {t("Выйти на всех устройствах", "Sign out everywhere")}
          </button>
        </form></>}
        <button
          className="text-button profile-signout"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await request("/auth/logout", {});
              await refresh();
            })
          }
        >
          <Icon name="logout" size={17} />
          {t("Выйти из аккаунта", "Sign out")}
        </button>
      </section>
    </div>
  );
}

function MatchPanel({
  room,
  busy,
  perform,
  refresh,
}: {
  room: Room;
  busy: boolean;
  perform: Perform;
  refresh: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const [view, setView] = useState<LabView | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [loadError, setLoadError] = useState(false);
  const pending = useRef<{
    value: number;
    revision: number;
    actionId: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let finished = false;
    const load = () => {
      if (finished || document.visibilityState !== "visible") return;
      void request<{ view: LabView }>(`/rooms/${room.roomId}/match`)
        .then((data) => {
          if (active) {
            setView((current) =>
              !current || data.view.revision >= current.revision
                ? data.view
                : current,
            );
            setLoadError(false);
            if (data.view.phase === "finished") {
              finished = true;
              clearInterval(timer);
              clearInterval(clockTimer);
            }
          }
        })
        .catch(() => {
          if (active) setLoadError(true);
        });
    };
    load();
    const timer = setInterval(load, 3000);
    const clockTimer = setInterval(() => {
      if (document.visibilityState === "visible") setClock(Date.now());
    }, 1000);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(clockTimer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [room.roomId]);
  const choose = (value: number) =>
    void perform(async () => {
      if (!view || !view.legalChoices.includes(value as 1 | 2 | 3)) return;
      if (
        pending.current?.value !== value ||
        pending.current?.revision !== view.revision
      )
        pending.current = {
          value,
          revision: view.revision,
          actionId: crypto.randomUUID(),
        };
      const data = await request<{ view: LabView }>(
        `/rooms/${room.roomId}/actions`,
        {
          actionId: pending.current.actionId,
          expectedRevision: pending.current.revision,
          payload: { type: "choose", value },
        },
      );
      setView((current) =>
        !current || data.view.revision >= current.revision
          ? data.view
          : current,
      );
      pending.current = null;
      await refresh();
    });
  const winners = view?.players
    .filter((player) =>
      view.outcome?.winnerParticipantIds.includes(player.participantId),
    )
    .map((player) => player.displayName)
    .join(", ");
  return (
    <section className="match-panel">
      <div className="section-title">
        <h3>{t("Пробный стол", "Practice table")}</h3>
        {view && (
          <span className="tag success">
            {view.phase === "finished"
              ? t("Партия завершена", "Game finished")
              : `${t("Раунд", "Round")} ${view.round}/${view.totalRounds}`}
          </span>
        )}
      </div>
      <p>
        {t(
          "Выберите число от 1 до 3. Самое большое число, которое выбрал только один участник, приносит ему очко. Выбор раскрывается, когда ответят все.",
          "Choose a number from 1 to 3. The highest number picked by exactly one player earns a point. Choices are revealed when everyone answers.",
        )}
      </p>
      {loadError && (
        <div className="inline-error" role="status">
          {t("Нет связи. Пробуем снова…", "No connection. Trying again…")}
        </div>
      )}
      {!view ? (
        <span className="spinner" />
      ) : (
        <>
          <div className="lab-layout">
            <div className="lab-choice-panel">
              {view.phase === "finished" ? (
                <div className="lab-result">
                  <span className="result-star" aria-hidden="true">
                    ✦
                  </span>
                  <h4>
                    {view.outcome?.winnerParticipantIds.length === 1
                      ? t("Победитель", "Winner")
                      : t("Разделили первое место", "Shared first place")}
                  </h4>
                  <strong>{winners}</strong>
                </div>
              ) : (
                <>
                  <div className="lab-countdown">
                    <span>{t("Ваш выбор", "Your choice")}</span>
                    <time>
                      {Math.max(
                        0,
                        Math.ceil(((view.deadlineAt ?? clock) - clock) / 1000),
                      )}{" "}
                      {t("сек.", "sec")}
                    </time>
                  </div>
                  <div className="number-choices">
                    {([1, 2, 3] as const).map((value) => (
                      <button
                        key={value}
                        className={`number-choice ${view.you.choice === value ? "chosen" : ""}`}
                        disabled={busy || !view.legalChoices.includes(value)}
                        aria-pressed={view.you.choice === value}
                        onClick={() => choose(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                  <p className="choice-caption">
                    {view.you.choice
                      ? t("Ждём остальных.", "Waiting for the others.")
                      : t(
                          "Выберите число. Остальные пока его не видят.",
                          "Pick a number. The others cannot see it yet.",
                        )}
                  </p>
                </>
              )}
            </div>
            <div className="lab-scoreboard">
              {view.players.map((player) => (
                <div className="lab-player" key={player.participantId}>
                  <span
                    className={`lab-player-dot ${player.isBot ? "bot" : ""}`}
                  >
                    {player.isBot ? (
                      <Icon name="robot" size={17} />
                    ) : (
                      <Icon name="friends" size={17} />
                    )}
                  </span>
                  <span>
                    <strong>{player.displayName}</strong>
                    <small>
                      {player.isBot
                        ? t("Бот", "Bot")
                        : player.participantId === view.you.participantId
                          ? t("Вы", "You")
                          : t("Игрок", "Player")}
                    </small>
                  </span>
                  <span className="lab-submitted">
                    {view.phase === "choosing" &&
                      (player.submitted ? (
                        <Icon name="check" size={17} />
                      ) : (
                        "…"
                      ))}
                  </span>
                  <b className="lab-score">{player.score}</b>
                </div>
              ))}
            </div>
          </div>
          {view.history.length > 0 && (
            <div className="round-history">
              <h4>{t("Результаты раундов", "Round results")}</h4>
              {view.history.map((round) => (
                <div className="round-result" key={round.round}>
                  <strong>
                    {t("Раунд", "Round")} {round.round}
                  </strong>
                  <div>
                    {view.players.map((player) => (
                      <span
                        className={`revealed-choice ${round.winnerParticipantId === player.participantId ? "winner" : ""}`}
                        key={player.participantId}
                      >
                        {player.displayName}
                        <b>{round.choices[player.participantId]}</b>
                        {round.timedOut.includes(player.participantId) && (
                          <small>{t("время вышло", "Time ran out")}</small>
                        )}
                      </span>
                    ))}
                  </div>
                  <small>
                    {round.winnerParticipantId
                      ? `${t("Очко:", "Point:")} ${view.players.find((player) => player.participantId === round.winnerParticipantId)?.displayName}`
                      : t("В этом раунде без очков", "No points this round")}
                  </small>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
