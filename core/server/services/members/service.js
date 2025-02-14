const MembersSSR = require('@tryghost/members-ssr');
const db = require('../../data/db');
const MembersConfigProvider = require('./config');
const MembersCSVImporter = require('./importer');
const MembersStats = require('./stats');
const createMembersApiInstance = require('./api');
const createMembersSettingsInstance = require('./settings');
const events = require('../../lib/common/events');
const logging = require('@tryghost/logging');
const urlUtils = require('../../../shared/url-utils');
const settingsCache = require('../../../shared/settings-cache');
const config = require('../../../shared/config');
const ghostVersion = require('@tryghost/version');
const _ = require('lodash');

const membersConfig = new MembersConfigProvider({
    config,
    settingsCache,
    urlUtils,
    logging,
    ghostVersion
});

let membersApi;
let membersSettings;

function reconfigureMembersAPI() {
    const reconfiguredMembersAPI = createMembersApiInstance(membersConfig);
    reconfiguredMembersAPI.bus.on('ready', function () {
        membersApi = reconfiguredMembersAPI;
    });
    reconfiguredMembersAPI.bus.on('error', function (err) {
        logging.error(err);
    });
}

const debouncedReconfigureMembersAPI = _.debounce(reconfigureMembersAPI, 600);

// Bind to events to automatically keep subscription info up-to-date from settings
events.on('settings.edited', function updateSettingFromModel(settingModel) {
    if (![
        'members_signup_access',
        'members_from_address',
        'members_support_address',
        'members_reply_address',
        'stripe_publishable_key',
        'stripe_secret_key',
        'stripe_product_name',
        'stripe_plans',
        'stripe_connect_publishable_key',
        'stripe_connect_secret_key',
        'stripe_connect_livemode',
        'stripe_connect_display_name',
        'stripe_connect_account_id'
    ].includes(settingModel.get('key'))) {
        return;
    }

    debouncedReconfigureMembersAPI();
});

const membersService = {
    async init() {
        const env = config.get('env');
        const paymentConfig = membersConfig.getStripePaymentConfig();

        if (env !== 'production') {
            if (!process.env.WEBHOOK_SECRET && membersConfig.isStripeConnected()) {
                throw new Error('Cannot use remote webhooks in development. Please restart in production mode or see https://ghost.org/docs/webhooks/#stripe-webhooks for developing with Stripe.');
            }

            if (paymentConfig && paymentConfig.secretKey.startsWith('sk_live')) {
                throw new Error('Cannot use live stripe keys in development. Please restart in production mode.');
            }
        } else {
            const siteUrl = urlUtils.getSiteUrl();
            if (!/^https/.test(siteUrl) && membersConfig.isStripeConnected()) {
                throw new Error('Cannot run Ghost without SSL when Stripe is connected. Please update your url config to use "https://"');
            }
        }
    },
    contentGating: require('./content-gating'),

    config: membersConfig,

    get api() {
        if (!membersApi) {
            membersApi = createMembersApiInstance(membersConfig);

            membersApi.bus.on('error', function (err) {
                logging.error(err);
            });
        }
        return membersApi;
    },

    get settings() {
        if (!membersSettings) {
            membersSettings = createMembersSettingsInstance(membersConfig);
        }
        return membersSettings;
    },

    ssr: MembersSSR({
        cookieSecure: urlUtils.isSSL(urlUtils.getSiteUrl()),
        cookieKeys: [settingsCache.get('theme_session_secret')],
        cookieName: 'ghost-members-ssr',
        cookieCacheName: 'ghost-members-ssr-cache',
        getMembersApi: () => membersService.api
    }),

    stripeConnect: require('./stripe-connect'),

    importer: new MembersCSVImporter({storagePath: config.getContentPath('data')}, settingsCache, () => membersApi),

    stats: new MembersStats({
        db: db,
        settingsCache: settingsCache,
        isSQLite: config.get('database:client') === 'sqlite3'
    })
};

module.exports = membersService;
module.exports.middleware = require('./middleware');
