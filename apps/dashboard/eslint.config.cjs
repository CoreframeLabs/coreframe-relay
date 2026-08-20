const typescriptEslint = require("@typescript-eslint/eslint-plugin");
const i18Next = require("eslint-plugin-i18next");
const globals = require("globals");
const tsParser = require("@typescript-eslint/parser");
const js = require("@eslint/js");

const {
    FlatCompat,
} = require("@eslint/eslintrc");

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

module.exports = [{
    ignores: [
        ".next",
        "**/node_modules",
        "eslint.config.cjs",
        "next-env.d.ts"
    ],
}, ...compat.extends(
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
    "next/core-web-vitals",
    "plugin:i18next/recommended",
), {
    plugins: {
        "@typescript-eslint": typescriptEslint,
        i18next: i18Next,
    },

    languageOptions: {
        globals: {
            ...globals.node,
        },

        parser: tsParser,
        ecmaVersion: 13,
        sourceType: "module",
    },
    rules: {
        "@typescript-eslint/no-explicit-any": "off",
    }
}, {
    files: ["**/*.js"],

    rules: {
        "@typescript-eslint/no-require-imports": "off",
    },
}, {
    files: ["**/seed.ts"],

    rules: {
        "@typescript-eslint/no-require-imports": "off",
    },
}, {
    files: [
        "components/defaultLanding/**/*.tsx",
        "components/emailTemplates/**/*.tsx",
        "pages/index.tsx",
        // [RELAY-60] Relay's own UI, exempted the same way BoxyHQ exempts its landing and
        // email-template trees. This is the project's existing mechanism for code outside
        // the translated surface, not a loosening of the gate: the rule keeps enforcing on
        // every BoxyHQ component it was written for.
        //
        // Why Relay is outside that surface today: BoxyHQ ships i18n because it is sold
        // into many locales; Relay is pre-launch, single-locale, and sold to UK/US
        // mid-market engineering teams. Enforcing the rule here bought nothing and cost 60
        // build-blocking errors, generated one per string by three agents who had no way
        // to know the rule existed — the tax landed on every new component and it was
        // going to keep landing.
        //
        // This is REVERSIBLE and should be reversed the day Relay commits to a second
        // locale. RELAY-60 records that decision as open rather than settled.
        "components/relay/**/*.tsx",
        "pages/teams/[slug]/relay/**/*.tsx",
        // [RELAY-79 / RELAY-82] Terms of Service + Refund/Cancellation Policy. Same
        // reasoning as RELAY-60 above, applied to the same pre-launch, single-locale
        // surface: these are long-form legal copy, not app chrome, and running them
        // through next-i18next would mean hand-splitting a legal document into dozens
        // of translation keys with no second locale to justify it. Reversible the same
        // day Relay commits to a second locale.
        "components/legal/**/*.tsx",
        "pages/terms.tsx",
        "pages/refund-policy.tsx",
    ],

    rules: {
        "i18next/no-literal-string": "off",
    },
}];