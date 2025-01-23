// Copyright 2017 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { join, normalize, extname, dirname, basename } from 'path';
import { pathToFileURL } from 'url';
import * as os from 'os';
import { chmod, realpath, writeFile } from 'fs-extra';
import { randomBytes } from 'crypto';
import { createParser } from 'dashdash';

import normalizePath from 'normalize-path';
import fastGlob from 'fast-glob';
import PQueue from 'p-queue';
import { get, pick, isNumber, isBoolean, some, debounce, noop } from 'lodash';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain as ipc,
  Menu,
  nativeTheme,
  net,
  powerSaveBlocker,
  screen,
  session,
  shell,
  systemPreferences,
  Notification,
  safeStorage,
  protocol as electronProtocol,
} from 'electron';
import type { MenuItemConstructorOptions, Settings } from 'electron';
import { z } from 'zod';

import packageJson from '../package.json';
import * as GlobalErrors from './global_errors';
import { setup as setupCrashReports } from './crashReports';
import { setup as setupSpellChecker } from './spell_check';
import { getDNSFallback } from './dns-fallback';
import { redactAll, addSensitivePath } from '../ts/util/privacy';
import { createSupportUrl } from '../ts/util/createSupportUrl';
import { missingCaseError } from '../ts/util/missingCaseError';
import { strictAssert } from '../ts/util/assert';
import { drop } from '../ts/util/drop';
import { createBufferedConsoleLogger } from '../ts/util/consoleLogger';
import type { ThemeSettingType } from '../ts/types/StorageUIKeys';
import { ThemeType } from '../ts/types/Util';
import * as Errors from '../ts/types/errors';
import { resolveCanonicalLocales } from '../ts/util/resolveCanonicalLocales';
import * as debugLog from '../ts/logging/debuglogs';
import * as uploadDebugLog from '../ts/logging/uploadDebugLog';
import { explodePromise } from '../ts/util/explodePromise';

import './startup_config';

import type { RendererConfigType } from '../ts/types/RendererConfig';
import {
  directoryConfigSchema,
  rendererConfigSchema,
} from '../ts/types/RendererConfig';
import config from './config';
import {
  Environment,
  getEnvironment,
  isTestEnvironment,
} from '../ts/environment';

// Very important to put before the single instance check, since it is based on the
//   userData directory. (see requestSingleInstanceLock below)
import * as userConfig from './user_config';

// We generally want to pull in our own modules after this point, after the user
//   data directory has been set.
import * as attachments from './attachments';
import * as attachmentChannel from './attachment_channel';
import * as bounce from '../ts/services/bounce';
import * as updater from '../ts/updater/index';
import { updateDefaultSession } from './updateDefaultSession';
import { PreventDisplaySleepService } from './PreventDisplaySleepService';
import { SystemTrayService, focusAndForceToTop } from './SystemTrayService';
import { SystemTraySettingCache } from './SystemTraySettingCache';
import { OptionalResourceService } from './OptionalResourceService';
import { EmojiService } from './EmojiService';
import {
  SystemTraySetting,
  shouldMinimizeToSystemTray,
  parseSystemTraySetting,
} from '../ts/types/SystemTraySetting';
import {
  getDefaultSystemTraySetting,
  isSystemTraySupported,
} from '../ts/types/Settings';
import * as ephemeralConfig from './ephemeral_config';
import * as logging from '../ts/logging/main_process_logging';
import { MainSQL } from '../ts/sql/main';
import * as sqlChannels from './sql_channel';
import * as windowState from './window_state';
import type { CreateTemplateOptionsType } from './menu';
import { createTemplate } from './menu';
import { installFileHandler, installWebHandler } from './protocol_filter';
import OS from '../ts/util/os/osMain';
import { isProduction } from '../ts/util/version';
import { clearTimeoutIfNecessary } from '../ts/util/clearTimeoutIfNecessary';
import { toggleMaximizedBrowserWindow } from '../ts/util/toggleMaximizedBrowserWindow';
import { ChallengeMainHandler } from '../ts/main/challengeMain';
import { NativeThemeNotifier } from '../ts/main/NativeThemeNotifier';
import { PowerChannel } from '../ts/main/powerChannel';
import { SettingsChannel } from '../ts/main/settingsChannel';
import { maybeParseUrl, setUrlSearchParams } from '../ts/util/url';
import { getHeicConverter } from '../ts/workers/heicConverterMain';

import type { LocaleDirection, LocaleType } from './locale';
import { load as loadLocale } from './locale';

import type { LoggerType } from '../ts/types/Logging';
import { HourCyclePreference } from '../ts/types/I18N';
import { ScreenShareStatus } from '../ts/types/Calling';
import type { ParsedSignalRoute } from '../ts/util/signalRoutes';
import { parseSignalRoute } from '../ts/util/signalRoutes';
import * as dns from '../ts/util/dns';
import { ZoomFactorService } from '../ts/services/ZoomFactorService';
import { SafeStorageBackendChangeError } from '../ts/types/SafeStorageBackendChangeError';
import { LINUX_PASSWORD_STORE_FLAGS } from '../ts/util/linuxPasswordStoreFlags';
import { getOwn } from '../ts/util/getOwn';
import { safeParseLoose, safeParseUnknown } from '../ts/util/schemas';

const animationSettings = systemPreferences.getAnimationSettings();

if (OS.isMacOS()) {
  systemPreferences.setUserDefault(
    'SquirrelMacEnableDirectContentsWrite',
    'boolean',
    true
  );
}

// Keep a global reference of the window object, if you don't, the window will
//   be closed automatically when the JavaScript object is garbage collected.
let mainWindow: BrowserWindow | undefined;
let mainWindowCreated = false;
let loadingWindow: BrowserWindow | undefined;

// Create a buffered logger to hold our log lines until we fully initialize
// the logger in `app.on('ready')`
const consoleLogger = createBufferedConsoleLogger();

// These will be set after app fires the 'ready' event
let logger: LoggerType | undefined;
let preferredSystemLocales: Array<string> | undefined;
let localeOverride: string | null | undefined;

let resolvedTranslationsLocale: LocaleType | undefined;
let settingsChannel: SettingsChannel | undefined;

const activeWindows = new Set<BrowserWindow>();

function getMainWindow() {
  return mainWindow;
}

const development =
  getEnvironment() === Environment.Development ||
  getEnvironment() === Environment.Staging;

const ciMode = config.get<'full' | 'benchmark' | false>('ciMode');
const forcePreloadBundle = config.get<boolean>('forcePreloadBundle');
const localeDirectionTestingOverride = config.has(
  'localeDirectionTestingOverride'
)
  ? config.get<LocaleDirection>('localeDirectionTestingOverride')
  : null;

const preventDisplaySleepService = new PreventDisplaySleepService(
  powerSaveBlocker
);

const challengeHandler = new ChallengeMainHandler();

const nativeThemeNotifier = new NativeThemeNotifier();
nativeThemeNotifier.initialize();

let appStartInitialSpellcheckSetting = true;

let macInitialOpenUrlRoute: ParsedSignalRoute | undefined;

const cliParser = createParser({
  allowUnknown: true,
  options: [
    {
      name: 'lang',
      type: 'string',
    },
  ],
});

const cliOptions = cliParser.parse(process.argv);

const defaultWebPrefs = {
  devTools:
    process.argv.some(arg => arg === '--enable-dev-tools') ||
    getEnvironment() !== Environment.PackagedApp ||
    !isProduction(app.getVersion()),
  spellcheck: false,
  // https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/runtime_enabled_features.json5
  enableBlinkFeatures: [
    'CSSPseudoDir', // status=experimental, needed for RTL (ex: :dir(rtl))
    'CSSLogical', // status=experimental, needed for RTL (ex: margin-inline-start)
  ].join(','),
  enablePreferredSizeMode: true,
};

const DISABLE_GPU =
  OS.isLinux() && !process.argv.some(arg => arg === '--enable-gpu');

const DISABLE_IPV6 = process.argv.some(arg => arg === '--disable-ipv6');
const FORCE_ENABLE_CRASH_REPORTS = process.argv.some(
  arg => arg === '--enable-crash-reports'
);

const CLI_LANG = cliOptions.lang as string | undefined;

setupCrashReports(getLogger, showDebugLogWindow, FORCE_ENABLE_CRASH_REPORTS);

let sendDummyKeystroke: undefined | (() => void);
if (OS.isWindows()) {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const windowsNotifications = require('./WindowsNotifications');
    sendDummyKeystroke = windowsNotifications.sendDummyKeystroke;
  } catch (error) {
    getLogger().error(
      'Failed to initialize Windows Notifications:',
      error.stack
    );
  }
}

function showWindow() {
  if (!mainWindow) {
    return;
  }

  // Using focus() instead of show() seems to be important on Windows when our window
  //   has been docked using Aero Snap/Snap Assist. A full .show() call here will cause
  //   the window to reposition:
  //   https://github.com/signalapp/Signal-Desktop/issues/1429
  if (mainWindow.isVisible()) {
    focusAndForceToTop(mainWindow);
  } else {
    mainWindow.show();
  }
}

if (!process.mas) {
  console.log('making app single instance');
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    console.log('quitting; we are the second instance');
    app.exit();
  } else {
    app.on('second-instance', (_e: Electron.Event, argv: Array<string>) => {
      // Workaround to let AllowSetForegroundWindow succeed.
      // See https://www.npmjs.com/package/@signalapp/windows-dummy-keystroke for a full explanation of why this is needed.
      sendDummyKeystroke?.();

      // Someone tried to run a second instance, we should focus our window
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }

        showWindow();
      }
      if (!logger) {
        console.log(
          'second-instance: logger not initialized; skipping further checks'
        );
        return;
      }

      const route = maybeGetIncomingSignalRoute(argv);
      if (route != null) {
        handleSignalRoute(route);
      }
      return true;
    });

    // This event is received in macOS packaged builds.
    app.on('open-url', (event, incomingHref) => {
      event.preventDefault();
      const route = parseSignalRoute(incomingHref);

      if (route != null) {
        // When the app isn't open and you click a signal link to open the app, then
        // this event will emit before mainWindow is ready. We save the value for later.
        if (mainWindow == null || !mainWindow.webContents) {
          macInitialOpenUrlRoute = route;
          return;
        }

        handleSignalRoute(route);
      }
    });
  }
}

let sqlInitTimeStart = 0;
let sqlInitTimeEnd = 0;

const sql = new MainSQL();
const heicConverter = getHeicConverter();

async function getSpellCheckSetting(): Promise<boolean> {
  const value = ephemeralConfig.get('spell-check');
  if (typeof value === 'boolean') {
    getLogger().info('got fast spellcheck setting', value);
    return value;
  }

  // Default to `true` if setting doesn't exist yet
  ephemeralConfig.set('spell-check', true);

  getLogger().info('initializing spellcheck setting', true);

  return true;
}

type GetThemeSettingOptionsType = Readonly<{
  ephemeralOnly?: boolean;
}>;

async function getThemeSetting({
  ephemeralOnly = false,
}: GetThemeSettingOptionsType = {}): Promise<ThemeSettingType> {
  const value = ephemeralConfig.get('theme-setting');
  if (value !== undefined) {
    getLogger().info('got fast theme-setting value', value);
  } else if (ephemeralOnly) {
    return 'system';
  }

  // Default to `system` if setting doesn't exist or is invalid
  const validatedResult =
    value === 'light' || value === 'dark' || value === 'system'
      ? value
      : 'system';

  if (value !== validatedResult) {
    ephemeralConfig.set('theme-setting', validatedResult);
    getLogger().info('saving theme-setting value', validatedResult);
  }

  return validatedResult;
}

async function getResolvedThemeSetting(
  options?: GetThemeSettingOptionsType
): Promise<ThemeType> {
  const theme = await getThemeSetting(options);
  if (theme === 'system') {
    return nativeTheme.shouldUseDarkColors ? ThemeType.dark : ThemeType.light;
  }
  return ThemeType[theme];
}

type GetBackgroundColorOptionsType = GetThemeSettingOptionsType &
  Readonly<{
    signalColors?: boolean;
  }>;

async function getBackgroundColor(
  options?: GetBackgroundColorOptionsType
): Promise<string> {
  const theme = await getResolvedThemeSetting(options);

  if (theme === 'light') {
    return options?.signalColors ? '#3a76f0' : '#ffffff';
  }

  if (theme === 'dark') {
    return '#121212';
  }

  throw missingCaseError(theme);
}

async function getLocaleOverrideSetting(): Promise<string | null> {
  const value = ephemeralConfig.get('localeOverride');
  // eslint-disable-next-line eqeqeq -- Checking for null explicitly
  if (typeof value === 'string' || value === null) {
    getLogger().info('got fast localeOverride setting', value);
    return value;
  }

  // Default to `null` if setting doesn't exist yet
  ephemeralConfig.set('localeOverride', null);

  getLogger().info('initializing localeOverride setting', null);

  return null;
}

const zoomFactorService = new ZoomFactorService({
  async getZoomFactorSetting() {
    const item = await sql.sqlRead('getItemById', 'zoomFactor');
    if (typeof item?.value !== 'number') {
      return null;
    }
    return item.value;
  },
  async setZoomFactorSetting(zoomFactor) {
    await sql.sqlWrite('createOrUpdateItem', {
      id: 'zoomFactor',
      value: zoomFactor,
    });
  },
});

let systemTrayService: SystemTrayService | undefined;
const systemTraySettingCache = new SystemTraySettingCache(
  ephemeralConfig,
  process.argv
);

const windowFromUserConfig = userConfig.get('window');
const windowFromEphemeral = ephemeralConfig.get('window');
export const windowConfigSchema = z.object({
  maximized: z.boolean().optional(),
  autoHideMenuBar: z.boolean().optional(),
  fullscreen: z.boolean().optional(),
  width: z.number(),
  height: z.number(),
  x: z.number(),
  y: z.number(),
});
type WindowConfigType = z.infer<typeof windowConfigSchema>;

let windowConfig: WindowConfigType | undefined;
const windowConfigParsed = safeParseUnknown(
  windowConfigSchema,
  windowFromEphemeral || windowFromUserConfig
);
if (windowConfigParsed.success) {
  windowConfig = windowConfigParsed.data;
}

if (windowFromUserConfig) {
  userConfig.set('window', null);
  ephemeralConfig.set('window', windowConfig);
}

let menuOptions: CreateTemplateOptionsType | undefined;

function getLogger(): LoggerType {
  if (!logger) {
    console.warn('getLogger: Logger not yet initialized!');
    return consoleLogger;
  }

  return logger;
}

function getPreferredSystemLocales(): Array<string> {
  if (!preferredSystemLocales) {
    throw new Error('getPreferredSystemLocales: Locales not yet initialized!');
  }
  return preferredSystemLocales;
}

function getLocaleOverride(): string | null {
  if (typeof localeOverride === 'undefined') {
    throw new Error('getLocaleOverride: Locale not yet initialized!');
  }
  return localeOverride;
}

function getResolvedMessagesLocale(): LocaleType {
  if (!resolvedTranslationsLocale) {
    throw new Error('getResolvedMessagesLocale: Locale not yet initialized!');
  }

  return resolvedTranslationsLocale;
}

function getHourCyclePreference(): HourCyclePreference {
  if (process.platform !== 'darwin') {
    return HourCyclePreference.UnknownPreference;
  }
  if (systemPreferences.getUserDefault('AppleICUForce24HourTime', 'boolean')) {
    return HourCyclePreference.Prefer24;
  }
  if (systemPreferences.getUserDefault('AppleICUForce12HourTime', 'boolean')) {
    return HourCyclePreference.Prefer12;
  }
  return HourCyclePreference.UnknownPreference;
}

type PrepareUrlOptions = {
  forCalling?: boolean;
  forCamera?: boolean;
  sourceName?: string;
};

async function prepareFileUrl(
  pathSegments: ReadonlyArray<string>,
  options: PrepareUrlOptions = {}
): Promise<string> {
  const filePath = join(...pathSegments);
  const fileUrl = pathToFileURL(filePath) as URL;
  return prepareUrl(fileUrl, options);
}

async function prepareUrl(
  url: URL,
  { forCalling, forCamera, sourceName }: PrepareUrlOptions = {}
): Promise<string> {
  return setUrlSearchParams(url, { forCalling, forCamera, sourceName }).href;
}

async function handleUrl(rawTarget: string) {
  const parsedUrl = maybeParseUrl(rawTarget);
  if (!parsedUrl) {
    return;
  }

  const signalRoute = parseSignalRoute(rawTarget);

  // We only want to specially handle urls that aren't requesting the dev server
  if (signalRoute != null) {
    handleSignalRoute(signalRoute);
    return;
  }

  const { protocol, hostname } = parsedUrl;
  const isDevServer =
    process.env.SIGNAL_ENABLE_HTTP && hostname === 'localhost';

  if ((protocol === 'http:' || protocol === 'https:') && !isDevServer) {
    try {
      await shell.openExternal(rawTarget);
    } catch (error) {
      getLogger().error(`Failed to open url: ${Errors.toLogFormat(error)}`);
    }
  }
}

async function handleCommonWindowEvents(window: BrowserWindow) {
  window.webContents.on('will-navigate', (event, rawTarget) => {
    event.preventDefault();

    drop(handleUrl(rawTarget));
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    drop(handleUrl(url));
    return { action: 'deny' };
  });
  window.webContents.on(
    'preload-error',
    (_event: Electron.Event, preloadPath: string, error: Error) => {
      getLogger().error(`Preload error in ${preloadPath}: `, error.message);
    }
  );

  activeWindows.add(window);
  window.on('closed', () => activeWindows.delete(window));

  const setWindowFocus = () => {
    window.webContents.send('set-window-focus', window.isFocused());
  };
  window.on('focus', setWindowFocus);
  window.on('blur', setWindowFocus);

  window.once('ready-to-show', setWindowFocus);
  // This is a fallback in case we drop an event for some reason.
  const focusInterval = setInterval(setWindowFocus, 10000);
  window.on('closed', () => clearInterval(focusInterval));

  await zoomFactorService.syncWindow(window);

  nativeThemeNotifier.addWindow(window);
}

const DEFAULT_WIDTH = ciMode ? 1024 : 800;
const DEFAULT_HEIGHT = ciMode ? 1024 : 610;

// We allow for smaller sizes because folks with OS-level zoom and HighDPI/Large Text
//   can really cause weirdness around window pixel-sizes. The app is very broken if you
//   make the window this small and do nothing else. But if you zoom out and collapse the
//   left pane, even this window size can work!
const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;
const BOUNDS_BUFFER = 100;

type BoundsType = {
  width: number;
  height: number;
  x: number;
  y: number;
};

function isVisible(window: BoundsType, bounds: BoundsType) {
  const boundsX = bounds?.x || 0;
  const boundsY = bounds?.y || 0;
  const boundsWidth = bounds?.width || DEFAULT_WIDTH;
  const boundsHeight = bounds?.height || DEFAULT_HEIGHT;

  // requiring BOUNDS_BUFFER pixels on the left or right side
  const rightSideClearOfLeftBound =
    window.x + window.width >= boundsX + BOUNDS_BUFFER;
  const leftSideClearOfRightBound =
    window.x <= boundsX + boundsWidth - BOUNDS_BUFFER;

  // top can't be offscreen, and must show at least BOUNDS_BUFFER pixels at bottom
  const topClearOfUpperBound = window.y >= boundsY;
  const topClearOfLowerBound =
    window.y <= boundsY + boundsHeight - BOUNDS_BUFFER;

  return (
    rightSideClearOfLeftBound &&
    leftSideClearOfRightBound &&
    topClearOfUpperBound &&
    topClearOfLowerBound
  );
}

let windowIcon: string;

if (OS.isWindows()) {
  windowIcon = join(__dirname, '../build/icons/win/icon.ico');
} else if (OS.isLinux()) {
  windowIcon = join(__dirname, '../images/signal-logo-desktop-linux.png');
} else {
  windowIcon = join(__dirname, '../build/icons/png/512x512.png');
}

// The titlebar is hidden on:
//   - Windows < 10 (7, 8)
//   - macOS (but no custom titlebar is displayed, see
//     `--title-bar-drag-area-height` in `stylesheets/_titlebar.scss`
const mainTitleBarStyle = OS.isMacOS()
  ? ('hidden' as const)
  : ('default' as const);

const nonMainTitleBarStyle = 'default' as const;

async function safeLoadURL(window: BrowserWindow, url: string): Promise<void> {
  let wasDestroyed = false;
  const onDestroyed = () => {
    wasDestroyed = true;
  };

  window.webContents.on('did-stop-loading', onDestroyed);
  window.webContents.on('destroyed', onDestroyed);
  try {
    await window.loadURL(url);
  } catch (error) {
    if (
      (wasDestroyed || windowState.readyForShutdown()) &&
      error?.code === 'ERR_FAILED'
    ) {
      getLogger().warn(
        'safeLoadURL: ignoring ERR_FAILED because we are shutting down',
        error
      );
      return;
    }
    throw error;
  } finally {
    try {
      window.webContents.removeListener('did-stop-loading', onDestroyed);
      window.webContents.removeListener('destroyed', onDestroyed);
    } catch {
      // We already logged or thrown an error - don't bother with handling the
      // error here.
    }
  }
}

async function createWindow() {
  const usePreloadBundle =
    !isTestEnvironment(getEnvironment()) || forcePreloadBundle;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: maxWidth, height: maxHeight } = primaryDisplay.workAreaSize;
  const width = windowConfig
    ? Math.min(windowConfig.width, maxWidth)
    : DEFAULT_WIDTH;
  const height = windowConfig
    ? Math.min(windowConfig.height, maxHeight)
    : DEFAULT_HEIGHT;

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    show: false,
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    autoHideMenuBar: false,
    titleBarStyle: mainTitleBarStyle,
    backgroundColor: isTestEnvironment(getEnvironment())
      ? '#ffffff' // Tests should always be rendered on a white background
      : await getBackgroundColor({ signalColors: true }),
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,
      contextIsolation: !isTestEnvironment(getEnvironment()),
      preload: join(
        __dirname,
        usePreloadBundle
          ? '../preload.wrapper.js'
          : '../ts/windows/main/preload.js'
      ),
      spellcheck: await getSpellCheckSetting(),
      backgroundThrottling: true,
      disableBlinkFeatures: 'Accelerated2dCanvas,AcceleratedSmallCanvases',
    },
    icon: windowIcon,
    ...pick(windowConfig, ['autoHideMenuBar', 'x', 'y']),
  };

  if (!isNumber(windowOptions.width) || windowOptions.width < MIN_WIDTH) {
    windowOptions.width = DEFAULT_WIDTH;
  }
  if (!isNumber(windowOptions.height) || windowOptions.height < MIN_HEIGHT) {
    windowOptions.height = DEFAULT_HEIGHT;
  }
  if (!isBoolean(windowOptions.autoHideMenuBar)) {
    delete windowOptions.autoHideMenuBar;
  }

  const startInTray =
    isTestEnvironment(getEnvironment()) ||
    (await systemTraySettingCache.get()) ===
      SystemTraySetting.MinimizeToAndStartInSystemTray;

  const haveFullWindowsBounds =
    isNumber(windowOptions.x) &&
    isNumber(windowOptions.y) &&
    isNumber(windowOptions.width) &&
    isNumber(windowOptions.height);
  if (haveFullWindowsBounds) {
    getLogger().info(
      `visibleOnAnyScreen(window): x=${windowOptions.x}, y=${windowOptions.y}, ` +
        `width=${windowOptions.width}, height=${windowOptions.height}`
    );

    const visibleOnAnyScreen = some(screen.getAllDisplays(), display => {
      const displayBounds = get(display, 'bounds');
      getLogger().info(
        `visibleOnAnyScreen(display #${display.id}): ` +
          `x=${displayBounds.x}, y=${displayBounds.y}, ` +
          `width=${displayBounds.width}, height=${displayBounds.height}`
      );

      return isVisible(windowOptions as BoundsType, displayBounds);
    });
    if (!visibleOnAnyScreen) {
      getLogger().info('visibleOnAnyScreen: Location reset needed');
      delete windowOptions.x;
      delete windowOptions.y;
    }
  }

  getLogger().info(
    'Initializing BrowserWindow config:',
    JSON.stringify(windowOptions)
  );

  // Create the browser window.
  mainWindow = new BrowserWindow(windowOptions);
  if (settingsChannel) {
    settingsChannel.setMainWindow(mainWindow);
  }

  mainWindowCreated = true;
  setupSpellChecker(
    mainWindow,
    getPreferredSystemLocales(),
    getLocaleOverride(),
    getResolvedMessagesLocale().i18n,
    getLogger()
  );
  if (!startInTray && windowConfig && windowConfig.maximized) {
    mainWindow.maximize();
  }
  if (!startInTray && windowConfig && windowConfig.fullscreen) {
    mainWindow.setFullScreen(true);
  }
  if (systemTrayService) {
    systemTrayService.setMainWindow(mainWindow);
  }

  function saveWindowStats() {
    if (!windowConfig) {
      return;
    }

    getLogger().info(
      'Updating BrowserWindow config: %s',
      JSON.stringify(windowConfig)
    );
    ephemeralConfig.set('window', windowConfig);
  }
  const debouncedSaveStats = debounce(saveWindowStats, 500);

  function captureWindowStats() {
    if (!mainWindow) {
      return;
    }

    const size = mainWindow.getSize();
    const position = mainWindow.getPosition();

    const newWindowConfig = {
      maximized: mainWindow.isMaximized(),
      autoHideMenuBar: mainWindow.autoHideMenuBar,
      fullscreen: mainWindow.isFullScreen(),
      width: size[0],
      height: size[1],
      x: position[0],
      y: position[1],
    };

    if (
      newWindowConfig.fullscreen !== windowConfig?.fullscreen ||
      newWindowConfig.maximized !== windowConfig?.maximized
    ) {
      mainWindow.webContents.send('window:set-window-stats', {
        isMaximized: newWindowConfig.maximized,
        isFullScreen: newWindowConfig.fullscreen,
      });
    }

    // so if we need to recreate the window, we have the most recent settings
    windowConfig = newWindowConfig;

    if (!windowState.requestedShutdown()) {
      debouncedSaveStats();
    }
  }

  mainWindow.on('resize', captureWindowStats);
  mainWindow.on('move', captureWindowStats);

  if (!ciMode && config.get<boolean>('openDevTools')) {
    // Open the DevTools.
    mainWindow.webContents.openDevTools();
  }

  await handleCommonWindowEvents(mainWindow);

  // App dock icon bounce
  bounce.init(mainWindow);

  // Emitted when the window is about to be closed.
  // Note: We do most of our shutdown logic here because all windows are closed by
  //   Electron before the app quits.
  mainWindow.on('close', async e => {
    if (!mainWindow) {
      getLogger().info('close event: no main window');
      return;
    }

    getLogger().info('close event', {
      readyForShutdown: windowState.readyForShutdown(),
      shouldQuit: windowState.shouldQuit(),
    });
    // If the application is terminating, just do the default
    if (
      isTestEnvironment(getEnvironment()) ||
      (windowState.readyForShutdown() && windowState.shouldQuit())
    ) {
      return;
    }

    // Prevent the shutdown
    e.preventDefault();

    // Disable media playback
    mainWindow.webContents.send('set-media-playback-disabled', true);

    // In certain cases such as during an active call, we ask the user to confirm close
    // which includes shutdown, clicking X on MacOS or closing to tray.
    let shouldClose = true;
    try {
      shouldClose = await maybeRequestCloseConfirmation();
    } catch (error) {
      getLogger().warn(
        'Error while requesting close confirmation.',
        Errors.toLogFormat(error)
      );
    }
    if (!shouldClose) {
      updater.onRestartCancelled();
      return;
    }

    /**
     * if the user is in fullscreen mode and closes the window, not the
     * application, we need them leave fullscreen first before closing it to
     * prevent a black screen.
     * Also check for mainWindow because it might become undefined while
     * waiting for close confirmation.
     *
     * issue: https://github.com/signalapp/Signal-Desktop/issues/4348
     */
    if (mainWindow) {
      if (mainWindow.isFullScreen()) {
        mainWindow.once('leave-full-screen', () => mainWindow?.hide());
        mainWindow.setFullScreen(false);
      } else {
        mainWindow.hide();
      }
    }

    // On Mac, or on other platforms when the tray icon is in use, the window
    // should be only hidden, not closed, when the user clicks the close button
    const usingTrayIcon = shouldMinimizeToSystemTray(
      await systemTraySettingCache.get()
    );
    if (
      mainWindow &&
      !windowState.shouldQuit() &&
      (usingTrayIcon || OS.isMacOS())
    ) {
      if (usingTrayIcon) {
        const shownTrayNotice = ephemeralConfig.get('shown-tray-notice');
        if (shownTrayNotice) {
          getLogger().info('close: not showing tray notice');
          return;
        }

        ephemeralConfig.set('shown-tray-notice', true);
        getLogger().info('close: showing tray notice');

        const n = new Notification({
          title: getResolvedMessagesLocale().i18n(
            'icu:minimizeToTrayNotification--title'
          ),
          body: getResolvedMessagesLocale().i18n(
            'icu:minimizeToTrayNotification--body'
          ),
        });

        n.show();
      }
      return;
    }

    windowState.markRequestedShutdown();
    await requestShutdown();
    windowState.markReadyForShutdown();

    await sql.close();
    app.quit();
  });

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    getLogger().info('main window closed event');
    mainWindow = undefined;
    if (settingsChannel) {
      settingsChannel.setMainWindow(mainWindow);
    }
    if (systemTrayService) {
      systemTrayService.setMainWindow(mainWindow);
    }
  });

  mainWindow.on('enter-full-screen', () => {
    getLogger().info('mainWindow enter-full-screen event');
    if (mainWindow) {
      mainWindow.webContents.send('full-screen-change', true);
    }
  });
  mainWindow.on('leave-full-screen', () => {
    getLogger().info('mainWindow leave-full-screen event');
    if (mainWindow) {
      mainWindow.webContents.send('full-screen-change', false);
    }
  });

  mainWindow.on('show', () => {
    if (mainWindow) {
      mainWindow.webContents.send('set-media-playback-disabled', false);
    }
  });

  mainWindow.once('ready-to-show', async () => {
    getLogger().info('main window is ready-to-show');

    // Ignore sql errors and show the window anyway
    await sqlInitPromise;

    if (!mainWindow) {
      return;
    }

    mainWindow.webContents.send('ci:event', 'db-initialized', {});

    const shouldShowWindow =
      !app.getLoginItemSettings().wasOpenedAsHidden &&
      !startInTray &&
      !config.get<boolean>('ciIsBackupIntegration');

    if (shouldShowWindow) {
      getLogger().info('showing main window');
      mainWindow.show();
    }
  });

  await safeLoadURL(
    mainWindow,
    getEnvironment() === Environment.Test
      ? await prepareFileUrl([__dirname, '../test/index.html'])
      : await prepareFileUrl([__dirname, '../background.html'])
  );
}

// Renderer asks if we are done with the database
ipc.handle('database-ready', async () => {
  if (!sqlInitPromise) {
    getLogger().error('database-ready requested, but sqlInitPromise is falsey');
    return;
  }

  const { error } = await sqlInitPromise;
  if (error) {
    getLogger().error(
      'database-ready requested, but got sql error',
      Errors.toLogFormat(error)
    );
    return;
  }

  getLogger().info('sending `database-ready`');
});

ipc.handle(
  'art-creator:uploadStickerPack',
  (_event: Electron.Event, data: unknown) => {
    const { promise, resolve } = explodePromise<unknown>();
    strictAssert(mainWindow, 'Main window did not exist');

    mainWindow.webContents.send('art-creator:uploadStickerPack', data);

    ipc.once('art-creator:uploadStickerPack:done', (_doneEvent, response) => {
      resolve(response);
    });

    return promise;
  }
);

ipc.on('art-creator:onUploadProgress', () => {
  stickerCreatorWindow?.webContents.send('art-creator:onUploadProgress');
});

ipc.on('show-window', () => {
  showWindow();
});

ipc.on('start-tracking-query-stats', () => {
  sql.startTrackingQueryStats();
});

ipc.on('stop-tracking-query-stats', (_event, options) => {
  sql.stopTrackingQueryStats(options);
});

ipc.on('title-bar-double-click', () => {
  if (!mainWindow) {
    return;
  }

  if (OS.isMacOS()) {
    switch (
      systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string')
    ) {
      case 'Minimize':
        mainWindow.minimize();
        break;
      case 'Maximize':
        toggleMaximizedBrowserWindow(mainWindow);
        break;
      default:
        // If this is disabled, it'll be 'None'. If it's anything else, that's unexpected,
        //   but we'll just no-op.
        break;
    }
  } else {
    // This is currently only supported on macOS. This `else` branch is just here when/if
    //   we add support for other operating systems.
    toggleMaximizedBrowserWindow(mainWindow);
  }
});

ipc.on('set-is-call-active', (_event, isCallActive) => {
  preventDisplaySleepService.setEnabled(isCallActive);

  if (!mainWindow) {
    return;
  }

  let backgroundThrottling: boolean;
  if (isCallActive) {
    getLogger().info('Background throttling disabled because a call is active');
    backgroundThrottling = false;
  } else {
    getLogger().info('Background throttling enabled because no call is active');
    backgroundThrottling = true;
  }

  mainWindow.webContents.setBackgroundThrottling(backgroundThrottling);
});

ipc.on('convert-image', async (event, uuid, data) => {
  const { error, response } = await heicConverter(uuid, data);
  event.reply(`convert-image:${uuid}`, { error, response });
});

let isReadyForUpdates = false;
async function readyForUpdates() {
  if (isReadyForUpdates) {
    return;
  }

  isReadyForUpdates = true;

  // First, handle requested signal URLs
  const incomingHref = maybeGetIncomingSignalRoute(process.argv);
  if (incomingHref) {
    handleSignalRoute(incomingHref);
  } else if (macInitialOpenUrlRoute) {
    handleSignalRoute(macInitialOpenUrlRoute);
  }

  // Discard value even if we don't handle a saved URL.
  macInitialOpenUrlRoute = undefined;

  // Second, start checking for app updates
  try {
    strictAssert(
      settingsChannel !== undefined,
      'SettingsChannel must be initialized'
    );
    await updater.start({
      settingsChannel,
      logger: getLogger(),
      getMainWindow,
      canRunSilently: () => {
        return (
          systemTrayService?.isVisible() === true &&
          mainWindow?.isVisible() !== true &&
          mainWindow?.webContents?.getBackgroundThrottling() !== false
        );
      },
    });
  } catch (error) {
    getLogger().error(
      'Error starting update checks:',
      Errors.toLogFormat(error)
    );
  }
}

async function forceUpdate() {
  try {
    getLogger().info('starting force update');
    await updater.force();
  } catch (error) {
    getLogger().error('Error during force update:', Errors.toLogFormat(error));
  }
}

ipc.once('ready-for-updates', readyForUpdates);

const TEN_MINUTES = 10 * 60 * 1000;
setTimeout(readyForUpdates, TEN_MINUTES);

function openContactUs() {
  drop(shell.openExternal(createSupportUrl({ locale: app.getLocale() })));
}

function openJoinTheBeta() {
  // If we omit the language, the site will detect the language and redirect
  drop(
    shell.openExternal('https://support.signal.org/hc/articles/360007318471')
  );
}

function openReleaseNotes() {
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.webContents.send('show-release-notes');
    return;
  }

  drop(
    shell.openExternal(
      `https://github.com/signalapp/Signal-Desktop/releases/tag/v${app.getVersion()}`
    )
  );
}

function openSupportPage() {
  // If we omit the language, the site will detect the language and redirect
  drop(
    shell.openExternal('https://support.signal.org/hc/sections/360001602812')
  );
}

function openForums() {
  drop(shell.openExternal('https://community.signalusers.org/'));
}

function showKeyboardShortcuts() {
  if (mainWindow) {
    mainWindow.webContents.send('show-keyboard-shortcuts');
  }
}

function setupAsNewDevice() {
  if (mainWindow) {
    mainWindow.webContents.send('set-up-as-new-device');
  }
}

function setupAsStandalone() {
  if (mainWindow) {
    mainWindow.webContents.send('set-up-as-standalone');
  }
}

let screenShareWindow: BrowserWindow | undefined;
async function showScreenShareWindow(sourceName: string | undefined) {
  if (screenShareWindow) {
    screenShareWindow.showInactive();
    return;
  }

  const width = 480;

  const display = screen.getPrimaryDisplay();
  const options = {
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#2e2e2e',
    darkTheme: true,
    frame: false,
    fullscreenable: false,
    height: 44,
    maximizable: false,
    minimizable: false,
    resizable: true,
    show: false,
    title: getResolvedMessagesLocale().i18n('icu:screenShareWindow'),
    titleBarStyle: nonMainTitleBarStyle,
    width,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      contextIsolation: true,
      preload: join(__dirname, '../bundles/screenShare/preload.js'),
    },
    x: Math.floor(display.size.width / 2) - width / 2,
    y: 24,
  };

  screenShareWindow = new BrowserWindow(options);

  await handleCommonWindowEvents(screenShareWindow);

  screenShareWindow.on('closed', () => {
    screenShareWindow = undefined;
  });

  screenShareWindow.once('ready-to-show', () => {
    if (screenShareWindow) {
      screenShareWindow.show();
    }
  });

  await safeLoadURL(
    screenShareWindow,
    await prepareFileUrl([__dirname, '../screenShare.html'], { sourceName })
  );
}

let callingDevToolsWindow: BrowserWindow | undefined;
async function showCallingDevToolsWindow() {
  if (callingDevToolsWindow) {
    callingDevToolsWindow.show();
    return;
  }

  const options = {
    height: 1200,
    width: 1000,
    alwaysOnTop: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    darkTheme: false,
    frame: true,
    fullscreenable: true,
    maximizable: true,
    minimizable: true,
    resizable: true,
    show: false,
    title: getResolvedMessagesLocale().i18n('icu:callingDeveloperTools'),
    titleBarStyle: nonMainTitleBarStyle,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      contextIsolation: true,
      nativeWindowOpen: true,
      preload: join(__dirname, '../bundles/calling-tools/preload.js'),
    },
  };

  callingDevToolsWindow = new BrowserWindow(options);

  await handleCommonWindowEvents(callingDevToolsWindow);

  callingDevToolsWindow.once('closed', () => {
    callingDevToolsWindow = undefined;

    mainWindow?.webContents.send('calling:set-rtc-stats-interval', null);
  });

  ipc.on('calling:set-rtc-stats-interval', (_, intervalMillis: number) => {
    mainWindow?.webContents.send(
      'calling:set-rtc-stats-interval',
      intervalMillis
    );
  });

  ipc.on('calling:rtc-stats-report', (_, report) => {
    callingDevToolsWindow?.webContents.send('calling:rtc-stats-report', report);
  });

  await safeLoadURL(
    callingDevToolsWindow,
    await prepareFileUrl([__dirname, '../calling_tools.html'])
  );
  callingDevToolsWindow.show();
}

let aboutWindow: BrowserWindow | undefined;
async function showAbout() {
  if (aboutWindow) {
    aboutWindow.show();
    return;
  }

  const options = {
    width: 500,
    height: 500,
    resizable: true,
    title: getResolvedMessagesLocale().i18n('icu:aboutSignalDesktop'),
    titleBarStyle: nonMainTitleBarStyle,
    autoHideMenuBar: true,
    backgroundColor: await getBackgroundColor({ signalColors: true }),
    show: false,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      contextIsolation: true,
      preload: join(__dirname, '../bundles/about/preload.js'),
      nativeWindowOpen: true,
    },
  };

  aboutWindow = new BrowserWindow(options);

  await handleCommonWindowEvents(aboutWindow);

  aboutWindow.on('closed', () => {
    aboutWindow = undefined;
  });

  aboutWindow.once('ready-to-show', () => {
    if (aboutWindow) {
      aboutWindow.show();
    }
  });

  await safeLoadURL(
    aboutWindow,
    await prepareFileUrl([__dirname, '../about.html'])
  );
}

let settingsWindow: BrowserWindow | undefined;
async function showSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    return;
  }

  const options = {
    width: 700,
    height: 700,
    frame: true,
    resizable: true,
    title: getResolvedMessagesLocale().i18n('icu:signalDesktopPreferences'),
    titleBarStyle: mainTitleBarStyle,
    autoHideMenuBar: true,
    backgroundColor: await getBackgroundColor(),
    show: false,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      contextIsolation: true,
      preload: join(__dirname, '../bundles/settings/preload.js'),
      nativeWindowOpen: true,
    },
  };

  settingsWindow = new BrowserWindow(options);

  await handleCommonWindowEvents(settingsWindow);

  settingsWindow.on('closed', () => {
    settingsWindow = undefined;
  });

  ipc.once('settings-done-rendering', () => {
    if (!settingsWindow) {
      getLogger().warn('settings-done-rendering: no settingsWindow available!');
      return;
    }

    settingsWindow.show();
  });

  await safeLoadURL(
    settingsWindow,
    await prepareFileUrl([__dirname, '../settings.html'])
  );
}

async function getIsLinked() {
  try {
    const number = await sql.sqlRead('getItemById', 'number_id');
    const password = await sql.sqlRead('getItemById', 'password');
    return Boolean(number && password);
  } catch (e) {
    return false;
  }
}

async function openArtCreator() {
  if (!(await getIsLinked())) {
    const message = getResolvedMessagesLocale().i18n(
      'icu:ArtCreator--Authentication--error'
    );

    await dialog.showMessageBox({
      type: 'warning',
      message,
    });

    return;
  }

  await showStickerCreatorWindow();
}

let debugLogWindow: BrowserWindow | undefined;
async function showDebugLogWindow() {
  if (debugLogWindow) {
    doShowDebugLogWindow();
    return;
  }

  function doShowDebugLogWindow() {
    if (debugLogWindow) {
      // Electron has [a macOS bug][0] that causes parent windows to become unresponsive
      //   if it's fullscreen and opens a fullscreen child window. Until that's fixed, we
      //   only set the parent on MacOS is if the mainWindow is not fullscreen
      // [0]: https://github.com/electron/electron/issues/32374
      if (OS.isMacOS() && mainWindow?.isFullScreen()) {
        debugLogWindow.setParentWindow(null);
      } else {
        debugLogWindow.setParentWindow(mainWindow ?? null);
      }
      debugLogWindow.show();
    }
  }

  const options: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 500,
    resizable: true,
    title: getResolvedMessagesLocale().i18n('icu:debugLog'),
    titleBarStyle: nonMainTitleBarStyle,
    autoHideMenuBar: true,
    backgroundColor: await getBackgroundColor(),
    show: false,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      contextIsolation: true,
      preload: join(__dirname, '../bundles/debuglog/preload.js'),
    },
    parent: mainWindow,
  };

  debugLogWindow = new BrowserWindow(options);

  await handleCommonWindowEvents(debugLogWindow);

  debugLogWindow.on('closed', () => {
    debugLogWindow = undefined;
  });

  debugLogWindow.once('ready-to-show', () => {
    if (debugLogWindow) {
      doShowDebugLogWindow();

      // Electron sometimes puts the window in a strange spot until it's shown.
      debugLogWindow.center();
    }
  });

  await safeLoadURL(
    debugLogWindow,
    await prepareFileUrl([__dirname, '../debug_log.html'])
  );
}

let permissionsPopupWindow: BrowserWindow | undefined;
function showPermissionsPopupWindow(forCalling: boolean, forCamera: boolean) {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise<void>(async (resolveFn, reject) => {
    if (permissionsPopupWindow) {
      permissionsPopupWindow.show();
      reject(new Error('Permission window already showing'));
      return;
    }
    if (!mainWindow) {
      reject(new Error('No main window'));
      return;
    }

    const size = mainWindow.getSize();
    const options = {
      width: Math.min(400, size[0]),
      height: Math.min(150, size[1]),
      resizable: false,
      title: getResolvedMessagesLocale().i18n('icu:allowAccess'),
      titleBarStyle: nonMainTitleBarStyle,
      autoHideMenuBar: true,
      backgroundColor: await getBackgroundColor(),
      show: false,
      modal: true,
      webPreferences: {
        ...defaultWebPrefs,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        sandbox: true,
        contextIsolation: true,
        preload: join(__dirname, '../bundles/permissions/preload.js'),
        nativeWindowOpen: true,
      },
      parent: mainWindow,
    };

    permissionsPopupWindow = new BrowserWindow(options);

    await handleCommonWindowEvents(permissionsPopupWindow);

    permissionsPopupWindow.on('closed', () => {
      removeDarkOverlay();
      permissionsPopupWindow = undefined;

      resolveFn();
    });

    permissionsPopupWindow.once('ready-to-show', () => {
      if (permissionsPopupWindow) {
        addDarkOverlay();
        permissionsPopupWindow.show();
      }
    });

    await safeLoadURL(
      permissionsPopupWindow,
      await prepareFileUrl([__dirname, '../permissions_popup.html'], {
        forCalling,
        forCamera,
      })
    );
  });
}

const runSQLCorruptionHandler = async () => {
  // This is a glorified event handler. Normally, this promise never resolves,
  // but if there is a corruption error triggered by any query that we run
  // against the database - the promise will resolve and we will call
  // `onDatabaseError`.
  const error = await sql.whenCorrupted();

  getLogger().error(
    'Detected sql corruption in main process. ' +
      `Restarting the application immediately. Error: ${error.message}`
  );

  await onDatabaseError(error);
};

const runSQLReadonlyHandler = async () => {
  // This is a glorified event handler. Normally, this promise never resolves,
  // but if there is a corruption error triggered by any query that we run
  // against the database - the promise will resolve and we will call
  // `onDatabaseError`.
  const error = await sql.whenReadonly();

  getLogger().error(
    `Detected readonly sql database in main process: ${error.message}`
  );

  throw error;
};

function generateSQLKey(): string {
  getLogger().info(
    'key/initialize: Generating new encryption key, since we did not find it on disk'
  );
  // https://www.zetetic.net/sqlcipher/sqlcipher-api/#key
  return randomBytes(32).toString('hex');
}

function getSQLKey(): string {
  let update = false;
  const isLinux = OS.isLinux();
  const legacyKeyValue = userConfig.get('key');
  const modernKeyValue = userConfig.get('encryptedKey');
  const previousBackend = isLinux
    ? userConfig.get('safeStorageBackend')
    : undefined;

  const safeStorageBackend: string | undefined = isLinux
    ? safeStorage.getSelectedStorageBackend()
    : undefined;
  const isEncryptionAvailable =
    safeStorage.isEncryptionAvailable() &&
    (!isLinux || safeStorageBackend !== 'basic_text');

  // On Linux the backend can change based on desktop environment and command line flags.
  // If the backend changes we won't be able to decrypt the key.
  if (
    isLinux &&
    typeof previousBackend === 'string' &&
    previousBackend !== safeStorageBackend
  ) {
    console.error(
      `Detected change in safeStorage backend, can't decrypt DB key (previous: ${previousBackend}, current: ${safeStorageBackend})`
    );
    throw new SafeStorageBackendChangeError({
      currentBackend: String(safeStorageBackend),
      previousBackend,
    });
  }

  let key: string;
  if (typeof modernKeyValue === 'string') {
    if (!isEncryptionAvailable) {
      throw new Error("Can't decrypt database key");
    }

    getLogger().info('getSQLKey: decrypting key');
    const encrypted = Buffer.from(modernKeyValue, 'hex');
    key = safeStorage.decryptString(encrypted);

    if (legacyKeyValue != null) {
      getLogger().info('getSQLKey: removing legacy key');
      userConfig.set('key', undefined);
    }

    if (isLinux && previousBackend == null) {
      getLogger().info(
        `getSQLKey: saving safeStorageBackend: ${safeStorageBackend}`
      );
      userConfig.set('safeStorageBackend', safeStorageBackend);
    }
  } else if (typeof legacyKeyValue === 'string') {
    key = legacyKeyValue;
    update = isEncryptionAvailable;
    if (update) {
      getLogger().info('getSQLKey: migrating key');
    } else {
      getLogger().info('getSQLKey: using legacy key');
    }
  } else {
    getLogger().warn("getSQLKey: got key from config, but it wasn't a string");
    key = generateSQLKey();
    update = true;
  }

  if (!update) {
    return key;
  }

  if (isEncryptionAvailable) {
    getLogger().info('getSQLKey: updating encrypted key in the config');
    const encrypted = safeStorage.encryptString(key).toString('hex');
    userConfig.set('encryptedKey', encrypted);
    userConfig.set('key', undefined);

    if (isLinux && safeStorageBackend) {
      getLogger().info(
        `getSQLKey: saving safeStorageBackend: ${safeStorageBackend}`
      );
      userConfig.set('safeStorageBackend', safeStorageBackend);
    }
  } else {
    getLogger().info('getSQLKey: updating plaintext key in the config');
    userConfig.set('key', key);
  }

  return key;
}

async function initializeSQL(
  userDataPath: string
): Promise<{ ok: true; error: undefined } | { ok: false; error: Error }> {
  sqlInitTimeStart = Date.now();

  let key: string;
  try {
    key = getSQLKey();
  } catch (error) {
    try {
      // Initialize with *some* key to setup paths
      await sql.initialize({
        appVersion: app.getVersion(),
        configDir: userDataPath,
        key: 'abcd',
        logger: getLogger(),
      });
    } catch {
      // Do nothing, we fail right below anyway.
    }

    if (error instanceof Error) {
      return { ok: false, error };
    }

    return {
      ok: false,
      error: new Error(`initializeSQL: Caught a non-error '${error}'`),
    };
  }

  try {
    // This should be the first awaited call in this function, otherwise
    // `sql.sqlRead` will throw an uninitialized error instead of waiting for
    // init to finish.
    await sql.initialize({
      appVersion: app.getVersion(),
      configDir: userDataPath,
      key,
      logger: getLogger(),
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      return { ok: false, error };
    }

    return {
      ok: false,
      error: new Error(`initializeSQL: Caught a non-error '${error}'`),
    };
  } finally {
    sqlInitTimeEnd = Date.now();
  }

  sql.startTrackingQueryStats();

  // Only if we've initialized things successfully do we set up the corruption handler
  drop(runSQLCorruptionHandler());
  drop(runSQLReadonlyHandler());

  return { ok: true, error: undefined };
}

const onDatabaseError = async (error: Error) => {
  // Prevent window from re-opening
  ready = false;

  if (mainWindow) {
    mainWindow.close();
  }
  mainWindow = undefined;

  const { i18n } = getResolvedMessagesLocale();

  let deleteAllDataButtonIndex: number | undefined;
  let messageDetail: string;

  const buttons = [i18n('icu:copyErrorAndQuit')];
  const copyErrorAndQuitButtonIndex = 0;
  const SIGNAL_SUPPORT_LINK = 'https://support.signal.org/error';

  // Note that this error is thrown by the worker process and thus instanceof
  // check won't work.
  if (error.name === 'DBVersionFromFutureError') {
    // If the DB version is too new, the user likely opened an older version of Signal,
    // and they would almost never want to delete their data as a result, so we don't show
    // that option
    messageDetail = i18n('icu:databaseError__startOldVersion');
  } else if (error instanceof SafeStorageBackendChangeError) {
    const { currentBackend, previousBackend } = error;
    const previousBackendFlag = getOwn(
      LINUX_PASSWORD_STORE_FLAGS,
      previousBackend
    );
    messageDetail = previousBackendFlag
      ? i18n('icu:databaseError__safeStorageBackendChangeWithPreviousFlag', {
          currentBackend,
          previousBackend,
          previousBackendFlag,
        })
      : i18n('icu:databaseError__safeStorageBackendChange', {
          currentBackend,
          previousBackend,
        });
  } else {
    // Otherwise, this is some other kind of DB error, let's give them the option to
    // delete.
    messageDetail = i18n(
      'icu:databaseError__detail',
      { link: SIGNAL_SUPPORT_LINK },
      { bidi: 'strip' }
    );

    buttons.push(i18n('icu:deleteAndRestart'));
    deleteAllDataButtonIndex = 1;
  }

  const buttonIndex = dialog.showMessageBoxSync({
    buttons,
    defaultId: copyErrorAndQuitButtonIndex,
    cancelId: copyErrorAndQuitButtonIndex,
    message: i18n('icu:databaseError'),
    detail: messageDetail,
    noLink: true,
    type: 'error',
  });

  if (buttonIndex === copyErrorAndQuitButtonIndex) {
    clipboard.writeText(
      `Database startup error:\n\n${redactAll(Errors.toLogFormat(error))}\n\n` +
        `App Version: ${app.getVersion()}\n` +
        `OS: ${os.platform()}`
    );
  } else if (
    typeof deleteAllDataButtonIndex === 'number' &&
    buttonIndex === deleteAllDataButtonIndex
  ) {
    const confirmationButtons = [
      i18n('icu:cancel'),
      i18n('icu:deleteAndRestart'),
    ];
    const cancelButtonIndex = 0;
    const confirmDeleteAllDataButtonIndex = 1;
    const confirmationButtonIndex = dialog.showMessageBoxSync({
      buttons: confirmationButtons,
      defaultId: cancelButtonIndex,
      cancelId: cancelButtonIndex,
      message: i18n('icu:databaseError__deleteDataConfirmation'),
      detail: i18n('icu:databaseError__deleteDataConfirmation__detail'),
      noLink: true,
      type: 'warning',
    });

    if (confirmationButtonIndex === confirmDeleteAllDataButtonIndex) {
      getLogger().error('onDatabaseError: Deleting all data');
      await sql.removeDB();
      userConfig.remove();
      getLogger().error(
        'onDatabaseError: Requesting immediate restart after quit'
      );
      app.relaunch();
    }
  }

  getLogger().error('onDatabaseError: Quitting application');
  app.exit(1);
};

let sqlInitPromise:
  | Promise<{ ok: true; error: undefined } | { ok: false; error: Error }>
  | undefined;

ipc.on('database-readonly', (_event: Electron.Event, error: string) => {
  // Just let global_errors.ts handle it
  throw new Error(error);
});

function loadPreferredSystemLocales(): Array<string> {
  if (CLI_LANG != null) {
    try {
      // Normalizes locales so its safe to pass them into Intl apis.
      return Intl.getCanonicalLocales(CLI_LANG);
    } catch {
      // Ignore, totally invalid locale, fallback to system languages.
    }
  }

  if (getEnvironment() === Environment.Test) {
    return ['en'];
  }

  return app.getPreferredSystemLanguages();
}

async function getDefaultLoginItemSettings(): Promise<Settings> {
  if (!OS.isWindows()) {
    return {};
  }

  const systemTraySetting = await systemTraySettingCache.get();
  if (
    systemTraySetting !== SystemTraySetting.MinimizeToSystemTray &&
    // This is true when we just started with `--start-in-tray`
    systemTraySetting !== SystemTraySetting.MinimizeToAndStartInSystemTray
  ) {
    return {};
  }

  // The effect of this is that if both auto-launch and minimize to system tray
  // are enabled on Windows - we will start the app in tray automatically,
  // letting the Desktop shortcuts still start the Signal not in tray.
  return { args: ['--start-in-tray'] };
}

// Signal doesn't really use media keys so we set this switch here to unblock
// them so that other apps can use them if they need to.
const featuresToDisable = `HardwareMediaKeyHandling,${app.commandLine.getSwitchValue(
  'disable-features'
)}`;
app.commandLine.appendSwitch('disable-features', featuresToDisable);

// <canvas/> rendering is often utterly broken on Linux when using GPU
// acceleration.
if (DISABLE_GPU) {
  app.disableHardwareAcceleration();
}

// This has to run before the 'ready' event.
electronProtocol.registerSchemesAsPrivileged([
  {
    scheme: 'attachment',
    privileges: {
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
let ready = false;
app.on('ready', async () => {
  dns.setFallback(await getDNSFallback());
  if (DISABLE_IPV6) {
    dns.setIPv6Enabled(false);
  }

  const [userDataPath, crashDumpsPath, installPath] = await Promise.all([
    realpath(app.getPath('userData')),
    realpath(app.getPath('crashDumps')),
    realpath(app.getAppPath()),
  ]);

  updateDefaultSession(session.defaultSession, getLogger);

  if (getEnvironment() !== Environment.Test) {
    installFileHandler({
      session: session.defaultSession,
      userDataPath,
      installPath,
      isWindows: OS.isWindows(),
    });
  }

  installWebHandler({
    enableHttp:
      Boolean(process.env.SIGNAL_ENABLE_HTTP) ||
      Boolean(process.env.REACT_DEVTOOLS),
    session: session.defaultSession,
  });

  logger = await logging.initialize(getMainWindow);

  // Write buffered information into newly created logger.
  consoleLogger.writeBufferInto(logger);

  const resourceService = OptionalResourceService.create(
    join(userDataPath, 'optionalResources')
  );
  await EmojiService.create(resourceService);

  if (!resolvedTranslationsLocale) {
    preferredSystemLocales = resolveCanonicalLocales(
      loadPreferredSystemLocales()
    );

    localeOverride = await getLocaleOverrideSetting();

    const hourCyclePreference = getHourCyclePreference();
    logger.info(`app.ready: hour cycle preference: ${hourCyclePreference}`);

    logger.info(
      `app.ready: preferred system locales: ${preferredSystemLocales.join(
        ', '
      )}`
    );
    resolvedTranslationsLocale = loadLocale({
      preferredSystemLocales,
      localeOverride,
      localeDirectionTestingOverride,
      hourCyclePreference,
      logger: getLogger(),
    });
  }

  sqlInitPromise = initializeSQL(userDataPath);

  // First run: configure Signal to minimize to tray. Additionally, on Windows
  // enable auto-start with start-in-tray so that starting from a Desktop icon
  // would still show the window.
  // (User can change these settings later)
  if (
    isSystemTraySupported(OS) &&
    (await systemTraySettingCache.get()) === SystemTraySetting.Uninitialized
  ) {
    const newValue = getDefaultSystemTraySetting(OS, app.getVersion());
    getLogger().info(`app.ready: setting system-tray-setting to ${newValue}`);
    systemTraySettingCache.set(newValue);

    ephemeralConfig.set('system-tray-setting', newValue);

    if (OS.isWindows()) {
      getLogger().info('app.ready: enabling open at login');
      app.setLoginItemSettings({
        ...(await getDefaultLoginItemSettings()),
        openAtLogin: true,
      });
    }
  }

  const startTime = Date.now();

  settingsChannel = new SettingsChannel();
  settingsChannel.install();

  settingsChannel.on('change:systemTraySetting', async rawSystemTraySetting => {
    const { openAtLogin } = app.getLoginItemSettings(
      await getDefaultLoginItemSettings()
    );

    const systemTraySetting = parseSystemTraySetting(rawSystemTraySetting);
    systemTraySettingCache.set(systemTraySetting);

    if (systemTrayService) {
      const isEnabled = shouldMinimizeToSystemTray(systemTraySetting);
      systemTrayService.setEnabled(isEnabled);
    }

    // Default login item settings might have changed, so update the object.
    getLogger().info('refresh-auto-launch: new value', openAtLogin);
    app.setLoginItemSettings({
      ...(await getDefaultLoginItemSettings()),
      openAtLogin,
    });
  });

  settingsChannel.on(
    'ephemeral-setting-changed',
    sendPreferencesChangedEventToWindows
  );

  // We use this event only a single time to log the startup time of the app
  // from when it's first ready until the loading screen disappears.
  ipc.once('signal-app-loaded', (event, info) => {
    const { preloadTime, connectTime, processedCount } = info;

    const loadTime = Date.now() - startTime;
    const sqlInitTime = sqlInitTimeEnd - sqlInitTimeStart;

    const messageTime = loadTime - preloadTime - connectTime;
    const messagesPerSec = (processedCount * 1000) / messageTime;

    const innerLogger = getLogger();
    innerLogger.info('App loaded - time:', loadTime);
    innerLogger.info('SQL init - time:', sqlInitTime);
    innerLogger.info('Preload - time:', preloadTime);
    innerLogger.info('WebSocket connect - time:', connectTime);
    innerLogger.info('Processed count:', processedCount);
    innerLogger.info('Messages per second:', messagesPerSec);

    sql.stopTrackingQueryStats({ epochName: 'App Load' });

    event.sender.send('ci:event', 'app-loaded', {
      loadTime,
      sqlInitTime,
      preloadTime,
      connectTime,
      processedCount,
      messagesPerSec,
    });
  });

  addSensitivePath(userDataPath);
  addSensitivePath(crashDumpsPath);

  if (getEnvironment() !== Environment.Test) {
    installFileHandler({
      session: session.defaultSession,
      userDataPath,
      installPath,
      isWindows: OS.isWindows(),
    });
  }

  logger.info('app ready');
  logger.info(`starting version ${packageJson.version}`);

  // This logging helps us debug user reports about broken devices.
  {
    let getMediaAccessStatus;
    // This function is not supported on Linux, so we have a fallback.
    if (systemPreferences.getMediaAccessStatus) {
      getMediaAccessStatus =
        systemPreferences.getMediaAccessStatus.bind(systemPreferences);
    } else {
      getMediaAccessStatus = noop;
    }
    logger.info(
      'media access status',
      getMediaAccessStatus('microphone'),
      getMediaAccessStatus('camera')
    );
  }

  GlobalErrors.updateLocale(resolvedTranslationsLocale);

  // If the sql initialization takes more than three seconds to complete, we
  // want to notify the user that things are happening
  const timeout = new Promise(resolveFn =>
    setTimeout(resolveFn, 3000, 'timeout')
  );

  // This color is to be used only in loading screen and in this case we should
  // never wait for the database to be initialized. Thus the theme setting
  // lookup should be done only in ephemeral config.
  const backgroundColor = await getBackgroundColor({
    ephemeralOnly: true,
    signalColors: true,
  });

  drop(
    // eslint-disable-next-line more/no-then
    Promise.race([sqlInitPromise, timeout]).then(async maybeTimeout => {
      if (maybeTimeout !== 'timeout') {
        return;
      }

      getLogger().info(
        'sql.initialize is taking more than three seconds; showing loading dialog'
      );

      loadingWindow = new BrowserWindow({
        show: false,
        width: 300,
        height: 280,
        resizable: false,
        frame: false,
        backgroundColor,
        webPreferences: {
          ...defaultWebPrefs,
          nodeIntegration: false,
          sandbox: true,
          contextIsolation: true,
          preload: join(__dirname, '../bundles/loading/preload.js'),
        },
        icon: windowIcon,
      });

      loadingWindow.once('ready-to-show', async () => {
        if (!loadingWindow) {
          return;
        }
        loadingWindow.show();
        // Wait for sql initialization to complete, but ignore errors
        await sqlInitPromise;
        loadingWindow.destroy();
        loadingWindow = undefined;
      });

      await safeLoadURL(
        loadingWindow,
        await prepareFileUrl([__dirname, '../loading.html'])
      );
    })
  );

  try {
    await attachments.clearTempPath(userDataPath);
  } catch (err) {
    logger.error(
      'main/ready: Error deleting temp dir:',
      Errors.toLogFormat(err)
    );
  }

  try {
    await attachments.deleteStaleDownloads(userDataPath);
  } catch (err) {
    logger.error(
      'main/ready: Error deleting stale downloads:',
      Errors.toLogFormat(err)
    );
  }

  // Initialize IPC channels before creating the window

  attachmentChannel.initialize({
    sql,
    configDir: userDataPath,
  });
  sqlChannels.initialize(sql);
  PowerChannel.initialize({
    send(event) {
      if (!mainWindow) {
        return;
      }
      mainWindow.webContents.send(event);
    },
  });

  // Run window preloading in parallel with database initialization.
  await createWindow();

  const { error: sqlError } = await sqlInitPromise;
  if (sqlError) {
    getLogger().error('sql.initialize was unsuccessful; returning early');

    await onDatabaseError(sqlError);

    return;
  }

  appStartInitialSpellcheckSetting = await getSpellCheckSetting();

  try {
    const IDB_KEY = 'indexeddb-delete-needed';
    const item = await sql.sqlRead('getItemById', IDB_KEY);
    if (item && item.value) {
      await sql.sqlWrite('removeIndexedDBFiles');
      await sql.sqlWrite('removeItemById', IDB_KEY);
    }
  } catch (err) {
    getLogger().error(
      '(ready event handler) error deleting IndexedDB:',
      Errors.toLogFormat(err)
    );
  }

  ready = true;

  setupMenu();

  systemTrayService = new SystemTrayService({
    i18n: resolvedTranslationsLocale.i18n,
  });
  systemTrayService.setMainWindow(mainWindow);
  systemTrayService.setEnabled(
    shouldMinimizeToSystemTray(await systemTraySettingCache.get())
  );

  await ensureFilePermissions([
    'config.json',
    'sql/db.sqlite',
    'sql/db.sqlite-wal',
    'sql/db.sqlite-shm',
  ]);
});

function setupMenu(options?: Partial<CreateTemplateOptionsType>) {
  const { platform } = process;
  menuOptions = {
    // options
    development,
    devTools: defaultWebPrefs.devTools,
    includeSetup: false,
    isProduction: isProduction(app.getVersion()),
    platform,

    // actions
    forceUpdate,
    openArtCreator,
    openContactUs,
    openForums,
    openJoinTheBeta,
    openReleaseNotes,
    openSupportPage,
    setupAsNewDevice,
    setupAsStandalone,
    showAbout,
    showDebugLog: showDebugLogWindow,
    showCallingDevTools: showCallingDevToolsWindow,
    showKeyboardShortcuts,
    showSettings: showSettingsWindow,
    showWindow,
    zoomIn,
    zoomOut,
    zoomReset,

    // overrides
    ...options,
  };
  const template = createTemplate(
    menuOptions,
    getResolvedMessagesLocale().i18n
  );
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWindow?.webContents.send('window:set-menu-options', {
    development: menuOptions.development,
    devTools: menuOptions.devTools,
    includeSetup: menuOptions.includeSetup,
    isProduction: menuOptions.isProduction,
    platform: menuOptions.platform,
  });
}

async function maybeRequestCloseConfirmation(): Promise<boolean> {
  if (!mainWindow || !mainWindow.webContents) {
    return true;
  }

  getLogger().info(
    'maybeRequestCloseConfirmation: Checking to see if close confirmation is needed'
  );
  const request = new Promise<boolean>(resolveFn => {
    let timeout: NodeJS.Timeout | undefined;

    if (!mainWindow) {
      resolveFn(true);
      return;
    }

    ipc.once('received-close-confirmation', (_event, result) => {
      getLogger().info('maybeRequestCloseConfirmation: Response received');

      clearTimeoutIfNecessary(timeout);
      resolveFn(result);
    });

    ipc.once('requested-close-confirmation', () => {
      getLogger().info(
        'maybeRequestCloseConfirmation: Confirmation dialog shown, waiting for user.'
      );
      clearTimeoutIfNecessary(timeout);
    });

    mainWindow.webContents.send('maybe-request-close-confirmation');

    // Wait a short time then proceed. Normally the dialog should be
    // shown right away.
    timeout = setTimeout(() => {
      getLogger().error(
        'maybeRequestCloseConfirmation: Response never received; continuing with close.'
      );
      resolveFn(true);
    }, 10 * 1000);
  });

  try {
    return await request;
  } catch (error) {
    getLogger().error(
      'maybeRequestCloseConfirmation error:',
      Errors.toLogFormat(error)
    );
    return true;
  }
}

async function requestShutdown() {
  if (!mainWindow || !mainWindow.webContents) {
    return;
  }

  getLogger().info('requestShutdown: Requesting close of mainWindow...');
  const request = new Promise<void>(resolveFn => {
    let timeout: NodeJS.Timeout | undefined;

    if (!mainWindow) {
      resolveFn();
      return;
    }

    ipc.once('now-ready-for-shutdown', (_event, error) => {
      getLogger().info('requestShutdown: Response received');

      if (error) {
        getLogger().error(
          'requestShutdown: got error, still shutting down.',
          error
        );
      }
      clearTimeoutIfNecessary(timeout);

      resolveFn();
    });

    mainWindow.webContents.send('get-ready-for-shutdown');

    // We'll wait two minutes, then force the app to go down. This can happen if someone
    //   exits the app before we've set everything up in preload() (so the browser isn't
    //   yet listening for these events), or if there are a whole lot of stacked-up tasks.
    // Note: two minutes is also our timeout for SQL tasks in data.js in the browser.
    timeout = setTimeout(
      () => {
        getLogger().error(
          'requestShutdown: Response never received; forcing shutdown.'
        );
        resolveFn();
      },
      2 * 60 * 1000
    );
  });

  try {
    await request;
  } catch (error) {
    getLogger().error('requestShutdown error:', Errors.toLogFormat(error));
  }
}

function getWindowDebugInfo() {
  const windows = BrowserWindow.getAllWindows();

  try {
    return {
      windowCount: windows.length,
      mainWindowExists: windows.some(win => win === mainWindow),
      mainWindowIsFullScreen: mainWindow?.isFullScreen(),
    };
  } catch {
    return {
      windowCount: 0,
      mainWindowExists: false,
      mainWindowIsFullScreen: false,
    };
  }
}

app.on('before-quit', e => {
  getLogger().info('before-quit event', {
    readyForShutdown: windowState.readyForShutdown(),
    shouldQuit: windowState.shouldQuit(),
    hasEventBeenPrevented: e.defaultPrevented,
    ...getWindowDebugInfo(),
  });

  systemTrayService?.markShouldQuit();
  windowState.markShouldQuit();
});

app.on('will-quit', e => {
  getLogger().info('will-quit event', {
    hasEventBeenPrevented: e.defaultPrevented,
    ...getWindowDebugInfo(),
  });
});

app.on('quit', e => {
  getLogger().info('quit event', {
    hasEventBeenPrevented: e.defaultPrevented,
    ...getWindowDebugInfo(),
  });
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  getLogger().info('main process handling window-all-closed');
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  const shouldAutoClose = !OS.isMacOS() || isTestEnvironment(getEnvironment());

  // Only automatically quit if the main window has been created
  // This is necessary because `window-all-closed` can be triggered by the
  // "optimizing application" window closing
  if (shouldAutoClose && mainWindowCreated) {
    app.quit();
  }
});

app.on('activate', () => {
  if (!ready) {
    return;
  }

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow) {
    mainWindow.show();
  } else {
    drop(createWindow());
  }
});

// Defense in depth. We never intend to open webviews or windows. Prevent it completely.
app.on(
  'web-contents-created',
  (_createEvent: Electron.Event, contents: Electron.WebContents) => {
    contents.on('will-attach-webview', attachEvent => {
      attachEvent.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
);

app.setAsDefaultProtocolClient('sgnl');
app.setAsDefaultProtocolClient('signalcaptcha');

ipc.on(
  'set-badge',
  (_event: Electron.Event, badge: number | 'marked-unread') => {
    if (badge === 'marked-unread') {
      if (process.platform === 'darwin') {
        // Will show a ● on macOS when undefined
        app.setBadgeCount(undefined);
      } else {
        // All other OS's need a number
        app.setBadgeCount(1);
      }
    } else {
      app.setBadgeCount(badge);
    }
  }
);

ipc.on('remove-setup-menu-items', () => {
  setupMenu();
});

ipc.on('add-setup-menu-items', () => {
  setupMenu({
    includeSetup: true,
  });
});

ipc.on('draw-attention', () => {
  if (!mainWindow) {
    return;
  }

  if (OS.isWindows() || OS.isLinux()) {
    mainWindow.flashFrame(true);
  }
});

ipc.on('restart', () => {
  getLogger().info('Relaunching application');
  app.relaunch();
  app.quit();
});
ipc.on('shutdown', () => {
  if (process.env.GENERATE_PRELOAD_CACHE) {
    windowState.markReadyForShutdown();
  }
  app.quit();
});

ipc.on(
  'set-auto-hide-menu-bar',
  (_event: Electron.Event, autoHide: boolean) => {
    if (mainWindow) {
      mainWindow.autoHideMenuBar = autoHide;
    }
  }
);

ipc.on(
  'set-menu-bar-visibility',
  (_event: Electron.Event, visibility: boolean) => {
    if (mainWindow) {
      mainWindow.setMenuBarVisibility(visibility);
    }
  }
);

ipc.on(
  'screen-share:status-change',
  (_event: Electron.Event, status: ScreenShareStatus) => {
    if (!screenShareWindow) {
      return;
    }

    if (status === ScreenShareStatus.Disconnected) {
      screenShareWindow.close();
    } else {
      screenShareWindow.webContents.send('status-change', status);
    }
  }
);

ipc.on('stop-screen-share', () => {
  if (mainWindow) {
    mainWindow.webContents.send('stop-screen-share');
  }
});

ipc.on(
  'show-screen-share',
  (_event: Electron.Event, sourceName: string | undefined) => {
    drop(showScreenShareWindow(sourceName));
  }
);

ipc.on('update-tray-icon', (_event: Electron.Event, unreadCount: number) => {
  if (systemTrayService) {
    systemTrayService.setUnreadCount(unreadCount);
  }
});

// Debug Log-related IPC calls

ipc.on('show-debug-log', showDebugLogWindow);
ipc.on(
  'show-debug-log-save-dialog',
  async (_event: Electron.Event, logText: string) => {
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: 'debuglog.txt',
      showsTagField: false,
    });
    if (filePath) {
      await writeFile(filePath, logText);
    }
  }
);

// Permissions Popup-related IPC calls

ipc.handle(
  'show-permissions-popup',
  async (_event: Electron.Event, forCalling: boolean, forCamera: boolean) => {
    try {
      await showPermissionsPopupWindow(forCalling, forCamera);
    } catch (error) {
      getLogger().error(
        'show-permissions-popup error:',
        Errors.toLogFormat(error)
      );
    }
  }
);

// Settings-related IPC calls

function addDarkOverlay() {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('add-dark-overlay');
  }
}
function removeDarkOverlay() {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('remove-dark-overlay');
  }
}

ipc.on('show-settings', showSettingsWindow);

ipc.on('delete-all-data', () => {
  if (settingsWindow) {
    settingsWindow.close();
  }
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('delete-all-data');
  }
});

ipc.on('get-config', async event => {
  const theme = await getResolvedThemeSetting();

  const directoryConfig = safeParseLoose(directoryConfigSchema, {
    directoryUrl: config.get<string | null>('directoryUrl') || undefined,
    directoryMRENCLAVE:
      config.get<string | null>('directoryMRENCLAVE') || undefined,
  });
  if (!directoryConfig.success) {
    throw new Error(
      `prepareUrl: Failed to parse renderer directory config ${JSON.stringify(
        directoryConfig.error.flatten()
      )}`
    );
  }

  const parsed = safeParseLoose(rendererConfigSchema, {
    name: packageJson.productName,
    availableLocales: getResolvedMessagesLocale().availableLocales,
    resolvedTranslationsLocale: getResolvedMessagesLocale().name,
    resolvedTranslationsLocaleDirection: getResolvedMessagesLocale().direction,
    hourCyclePreference: getResolvedMessagesLocale().hourCyclePreference,
    preferredSystemLocales: getPreferredSystemLocales(),
    localeOverride: getLocaleOverride(),
    version: app.getVersion(),
    buildCreation: config.get<number>('buildCreation'),
    buildExpiration: config.get<number>('buildExpiration'),
    challengeUrl: config.get<string>('challengeUrl'),
    serverUrl: config.get<string>('serverUrl'),
    storageUrl: config.get<string>('storageUrl'),
    updatesUrl: config.get<string>('updatesUrl'),
    resourcesUrl: config.get<string>('resourcesUrl'),
    cdnUrl0: config.get<string>('cdn.0'),
    cdnUrl2: config.get<string>('cdn.2'),
    cdnUrl3: config.get<string>('cdn.3'),
    certificateAuthority: config.get<string>('certificateAuthority'),
    environment:
      !isTestEnvironment(getEnvironment()) && ciMode
        ? Environment.PackagedApp
        : getEnvironment(),
    isMockTestEnvironment: Boolean(process.env.MOCK_TEST),
    ciMode,
    devTools: defaultWebPrefs.devTools,
    // Should be already computed and cached at this point
    dnsFallback: await getDNSFallback(),
    disableIPv6: DISABLE_IPV6,
    ciBackupPath: config.get<string | null>('ciBackupPath') || undefined,
    ciIsBackupIntegration: config.get<boolean>('ciIsBackupIntegration'),
    nodeVersion: process.versions.node,
    hostname: os.hostname(),
    osRelease: os.release(),
    osVersion: os.version(),
    appInstance: process.env.NODE_APP_INSTANCE || undefined,
    proxyUrl: process.env.HTTPS_PROXY || process.env.https_proxy || undefined,
    contentProxyUrl: config.get<string>('contentProxyUrl'),
    sfuUrl: config.get('sfuUrl'),
    reducedMotionSetting: DISABLE_GPU || animationSettings.prefersReducedMotion,
    registrationChallengeUrl: config.get<string>('registrationChallengeUrl'),
    serverPublicParams: config.get<string>('serverPublicParams'),
    serverTrustRoot: config.get<string>('serverTrustRoot'),
    genericServerPublicParams: config.get<string>('genericServerPublicParams'),
    backupServerPublicParams: config.get<string>('backupServerPublicParams'),
    theme,
    appStartInitialSpellcheckSetting,

    // paths
    crashDumpsPath: app.getPath('crashDumps'),
    homePath: app.getPath('home'),
    installPath: app.getAppPath(),
    userDataPath: app.getPath('userData'),

    directoryConfig: directoryConfig.data,

    // Only used by the main window
    isMainWindowFullScreen: Boolean(mainWindow?.isFullScreen()),
    isMainWindowMaximized: Boolean(mainWindow?.isMaximized()),

    // Only for tests
    argv: JSON.stringify(process.argv),
  } satisfies RendererConfigType);

  if (!parsed.success) {
    throw new Error(
      `prepareUrl: Failed to parse renderer config ${JSON.stringify(
        parsed.error.flatten()
      )}`
    );
  }

  // eslint-disable-next-line no-param-reassign
  event.returnValue = parsed.data;
});

// Ingested in preload.js via a sendSync call
ipc.on('locale-data', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = getResolvedMessagesLocale().messages;
});

// Ingested in preload.js via a sendSync call
ipc.on('locale-display-names', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = getResolvedMessagesLocale().localeDisplayNames;
});

// Ingested in preload.js via a sendSync call
ipc.on('country-display-names', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = getResolvedMessagesLocale().countryDisplayNames;
});

// TODO DESKTOP-5241
ipc.on('OS.getClassName', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = OS.getClassName();
});

ipc.handle(
  'DebugLogs.getLogs',
  async (_event, data: unknown, userAgent: string) => {
    return debugLog.getLog(
      data,
      process.versions.node,
      app.getVersion(),
      os.version(),
      userAgent,
      process.arch,
      app.runningUnderARM64Translation,
      OS.getLinuxName()
    );
  }
);

ipc.handle('DebugLogs.upload', async (_event, content: string) => {
  return uploadDebugLog.upload({
    content,
    appVersion: app.getVersion(),
    logger: getLogger(),
  });
});

ipc.on('get-user-data-path', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = app.getPath('userData');
});

// Refresh the settings window whenever preferences change
const sendPreferencesChangedEventToWindows = () => {
  for (const window of activeWindows) {
    if (window.webContents) {
      window.webContents.send('preferences-changed');
    }
  }
};
ipc.on('preferences-changed', sendPreferencesChangedEventToWindows);

function maybeGetIncomingSignalRoute(argv: Array<string>) {
  for (const arg of argv) {
    const route = parseSignalRoute(arg);
    if (route != null) {
      return route;
    }
  }
  return null;
}

function handleSignalRoute(route: ParsedSignalRoute) {
  const log = getLogger();

  if (mainWindow == null || !mainWindow.webContents) {
    log.error('handleSignalRoute: mainWindow is null or missing webContents');
    return;
  }

  log.info('handleSignalRoute: Matched signal route:', route.key);

  if (route.key === 'artAddStickers') {
    mainWindow.webContents.send('show-sticker-pack', {
      packId: route.args.packId,
      packKey: Buffer.from(route.args.packKey, 'hex').toString('base64'),
    });
  } else if (route.key === 'groupInvites') {
    mainWindow.webContents.send('show-group-via-link', {
      value: route.args.inviteCode,
    });
  } else if (route.key === 'contactByPhoneNumber') {
    mainWindow.webContents.send('show-conversation-via-signal.me', {
      kind: 'phoneNumber',
      value: route.args.phoneNumber,
    });
  } else if (route.key === 'contactByEncryptedUsername') {
    mainWindow.webContents.send('show-conversation-via-signal.me', {
      kind: 'encryptedUsername',
      value: route.args.encryptedUsername,
    });
  } else if (route.key === 'showConversation') {
    mainWindow.webContents.send('show-conversation-via-notification', {
      conversationId: route.args.conversationId,
      messageId: route.args.messageId,
      storyId: route.args.storyId,
    });
  } else if (route.key === 'startCallLobby') {
    mainWindow.webContents.send('start-call-lobby', {
      conversationId: route.args.conversationId,
    });
  } else if (route.key === 'linkCall') {
    mainWindow.webContents.send('start-call-link', {
      key: route.args.key,
    });
  } else if (route.key === 'showWindow') {
    mainWindow.webContents.send('show-window');
  } else if (route.key === 'cancelPresenting') {
    mainWindow.webContents.send('cancel-presenting');
  } else if (route.key === 'captcha') {
    challengeHandler.handleCaptcha(route.args.captchaId);
    // Show window after handling captcha
    showWindow();
  } else {
    log.info('handleSignalRoute: Unknown signal route:', route.key);
    mainWindow.webContents.send('unknown-sgnl-link');
  }
}

ipc.handle('install-sticker-pack', (_event, packId, packKeyHex) => {
  const packKey = Buffer.from(packKeyHex, 'hex').toString('base64');
  if (mainWindow) {
    mainWindow.webContents.send('install-sticker-pack', { packId, packKey });
  }
});

ipc.handle('ensure-file-permissions', () => ensureFilePermissions());

/**
 * Ensure files in the user's data directory have the proper permissions.
 * Optionally takes an array of file paths to exclusively affect.
 *
 * @param {string[]} [onlyFiles] - Only ensure permissions on these given files
 */
async function ensureFilePermissions(onlyFiles?: Array<string>) {
  getLogger().info('Begin ensuring permissions');

  const start = Date.now();
  const userDataPath = await realpath(app.getPath('userData'));
  // fast-glob uses `/` for all platforms
  const userDataGlob = normalizePath(join(userDataPath, '**', '*'));

  // Determine files to touch
  const files = onlyFiles
    ? onlyFiles.map(f => join(userDataPath, f))
    : await fastGlob(userDataGlob, {
        markDirectories: true,
        onlyFiles: false,
        ignore: ['**/Singleton*'],
      });

  getLogger().info(`Ensuring file permissions for ${files.length} files`);

  // Touch each file in a queue
  const q = new PQueue({ concurrency: 5, timeout: 1000 * 60 * 2 });
  drop(
    q.addAll(
      files.map(f => async () => {
        const isDir = f.endsWith('/');
        try {
          await chmod(normalize(f), isDir ? 0o700 : 0o600);
        } catch (error) {
          getLogger().error(
            'ensureFilePermissions: Error from chmod',
            error.message
          );
        }
      })
    )
  );

  await q.onEmpty();

  getLogger().info(`Finish ensuring permissions in ${Date.now() - start}ms`);
}

ipc.handle('get-media-access-status', async (_event, value) => {
  // This function is not supported on Linux
  if (!systemPreferences.getMediaAccessStatus) {
    return undefined;
  }

  return systemPreferences.getMediaAccessStatus(value);
});

ipc.handle('get-auto-launch', async () => {
  return app.getLoginItemSettings(await getDefaultLoginItemSettings())
    .openAtLogin;
});

ipc.handle('set-auto-launch', async (_event, value) => {
  const openAtLogin = Boolean(value);
  getLogger().info('set-auto-launch: new value', openAtLogin);
  app.setLoginItemSettings({
    ...(await getDefaultLoginItemSettings()),
    openAtLogin,
  });
});

ipc.on('show-message-box', (_event, { type, message }) => {
  drop(dialog.showMessageBox({ type, message }));
});

ipc.on('show-item-in-folder', (_event, folder) => {
  shell.showItemInFolder(folder);
});

ipc.handle('show-save-dialog', async (_event, { defaultPath }) => {
  if (!mainWindow) {
    getLogger().warn('show-save-dialog: no main window');

    return { canceled: true };
  }

  const { canceled, filePath: selectedFilePath } = await dialog.showSaveDialog(
    mainWindow,
    {
      defaultPath,
      showsTagField: false,
    }
  );
  if (canceled || selectedFilePath == null) {
    return { canceled: true };
  }

  // On Windows, if you change the path from the default, the extension is
  // removed. We want to make sure the extension is always there.
  const defaultExt = extname(defaultPath);
  const finalDirname = dirname(selectedFilePath);
  const finalBasename = basename(selectedFilePath, defaultExt);
  const finalFilePath = join(finalDirname, `${finalBasename}${defaultExt}`);

  return { canceled: false, filePath: finalFilePath };
});

ipc.handle('show-save-multi-dialog', async _event => {
  if (!mainWindow) {
    getLogger().warn('show-save-multi-dialog: no main window');

    return { canceled: true };
  }
  const { canceled, filePaths: selectedDirPaths } = await dialog.showOpenDialog(
    mainWindow,
    {
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    }
  );
  if (canceled || selectedDirPaths.length === 0) {
    return { canceled: true };
  }

  if (selectedDirPaths.length > 1) {
    getLogger().warn('show-save-multi-dialog: multiple directories selected');

    return { canceled: true };
  }

  return { canceled: false, dirPath: selectedDirPaths[0] };
});

ipc.handle('executeMenuRole', async ({ sender }, untypedRole) => {
  const role = untypedRole as MenuItemConstructorOptions['role'];

  const senderWindow = BrowserWindow.fromWebContents(sender);

  switch (role) {
    case 'undo':
      sender.undo();
      break;
    case 'redo':
      sender.redo();
      break;
    case 'cut':
      sender.cut();
      break;
    case 'copy':
      sender.copy();
      break;
    case 'paste':
      sender.paste();
      break;
    case 'pasteAndMatchStyle':
      sender.pasteAndMatchStyle();
      break;
    case 'delete':
      sender.delete();
      break;
    case 'selectAll':
      sender.selectAll();
      break;
    case 'reload':
      sender.reload();
      break;
    case 'toggleDevTools':
      sender.toggleDevTools();
      break;

    case 'togglefullscreen':
      senderWindow?.setFullScreen(!senderWindow?.isFullScreen());
      break;
    case 'minimize':
      senderWindow?.minimize();
      break;
    case 'close':
      senderWindow?.close();
      break;

    case 'quit':
      app.quit();
      break;

    default:
      // ignored
      break;
  }
});

ipc.handle('getMainWindowStats', async () => {
  return {
    isMaximized: windowConfig?.maximized ?? false,
    isFullScreen: windowConfig?.fullscreen ?? false,
  };
});

ipc.handle('getMenuOptions', async () => {
  return {
    development: menuOptions?.development ?? false,
    devTools: menuOptions?.devTools ?? false,
    includeSetup: menuOptions?.includeSetup ?? false,
    isProduction: menuOptions?.isProduction ?? true,
    platform: menuOptions?.platform ?? 'unknown',
  };
});

async function zoomIn() {
  await zoomFactorService.zoomIn();
}

async function zoomOut() {
  await zoomFactorService.zoomOut();
}

async function zoomReset() {
  await zoomFactorService.zoomReset();
}

ipc.handle(
  'net.resolveHost',
  (_event, hostname: string, queryType?: 'A' | 'AAAA') => {
    return net.resolveHost(hostname, {
      queryType,
    });
  }
);

let stickerCreatorWindow: BrowserWindow | undefined;
async function showStickerCreatorWindow() {
  if (stickerCreatorWindow) {
    stickerCreatorWindow.show();
    return;
  }

  const { x = 0, y = 0 } = windowConfig || {};

  const options = {
    x: x + 100,
    y: y + 100,
    width: 800,
    minWidth: 800,
    height: 815,
    minHeight: 750,
    frame: true,
    title: getResolvedMessagesLocale().i18n('icu:signalDesktopStickerCreator'),
    autoHideMenuBar: true,
    backgroundColor: await getBackgroundColor(),
    show: false,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      contextIsolation: true,
      preload: join(__dirname, '../ts/windows/sticker-creator/preload.js'),
      nativeWindowOpen: true,
    },
  };

  stickerCreatorWindow = new BrowserWindow(options);

  await handleCommonWindowEvents(stickerCreatorWindow);

  stickerCreatorWindow.once('ready-to-show', () => {
    stickerCreatorWindow?.show();
  });

  stickerCreatorWindow.on('closed', () => {
    stickerCreatorWindow = undefined;
  });

  await safeLoadURL(
    stickerCreatorWindow,
    await prepareFileUrl([__dirname, '../sticker-creator/dist/index.html'])
  );
}

if (isTestEnvironment(getEnvironment())) {
  ipc.on('ci:test-electron:getArgv', event => {
    // eslint-disable-next-line no-param-reassign
    event.returnValue = process.argv;
  });

  ipc.handle('ci:test-electron:debug', async (_event, info) => {
    process.stdout.write(`ci:test-electron:debug=${JSON.stringify(info)}\n`);
  });

  ipc.handle('ci:test-electron:event', async (_event, event) => {
    process.stdout.write(
      `ci:test-electron:event=${JSON.stringify(event)}\n`,
      () => {
        if (event.type !== 'end') {
          return;
        }
        if (!process.env.TEST_QUIT_ON_COMPLETE) {
          return;
        }
        app.quit();
      }
    );
  });
}
