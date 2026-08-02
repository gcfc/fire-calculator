// Legal copy, kept as plain data so it has exactly ONE source of truth. The app links to it and the
// build script renders it into standalone /privacy and /terms pages — if this file changes, both move
// together. No JSX here on purpose: the build script imports it in plain Node.
//
// Every privacy claim below is verifiable against the source. The project contains no storage, cookie,
// analytics or telemetry code of any kind, and the only external request the page makes is for its
// webfonts. Where something DOES leave the browser (share links, fonts, host access logs) it is stated
// rather than glossed over.

export const SITE_NAME = "FIRE model";

export const PRIVACY = {
  slug: "privacy",
  title: "Privacy Policy",
  summary: "Everything is calculated in your browser. Nothing you type is collected, stored or transmitted.",
  sections: [
    {
      heading: "The short version",
      paragraphs: [
        "This site does not collect, store, transmit or sell anything you enter. There are no accounts, no cookies, no local storage, no analytics and no tracking of any kind. The figures you type exist only in your browser tab, and closing it discards them. We cannot see them, because they are never sent anywhere.",
      ],
    },
    {
      heading: "How the calculator works",
      paragraphs: [
        "The entire financial model runs locally, as JavaScript in your browser. There is no backend, no API and no database. The page is a single static file served to you once; after that it performs every calculation on your own device.",
      ],
    },
    {
      heading: "Share links",
      paragraphs: [
        "If you choose to create a share link, your inputs are compressed into the link itself — specifically into the URL fragment, the part after the “#”. Browsers do not send the fragment to web servers, so the data is not transmitted to us or to the host by opening the link.",
        "It does, however, travel to anyone you give the link to, and to anyone they forward it to. Treat a share link exactly as you would treat the numbers inside it. If you want to share the chart without revealing your inputs, use the plot-only option, which encodes the computed curve and no raw figures.",
      ],
    },
    {
      heading: "Third parties",
      paragraphs: [
        "Two things are worth stating plainly. First, the page loads its typefaces from Google Fonts, so your browser makes a request to Google to fetch them, and Google may log that request including your IP address. Second, this site is served as static files by a web host, and that host may keep ordinary access logs (such as IP address, timestamp and user agent) as any web server does. Neither of these involves the figures you enter, which never leave your browser.",
        "There are no advertising networks, no third-party analytics, no embedded trackers and no social media widgets on this site.",
      ],
    },
    {
      heading: "Children",
      paragraphs: [
        "This is a general-audience financial planning tool and is not directed at children. Because no personal information is collected from anyone, none is collected from children either.",
      ],
    },
    {
      heading: "Changes",
      paragraphs: [
        "If this policy changes, the updated version will be published on this page. Because no contact details are collected, there is no mailing list to notify.",
      ],
    },
  ],
};

export const TERMS = {
  slug: "terms",
  title: "Terms & Conditions",
  summary: "A free educational tool, provided as is, with no warranty and no liability. Not financial advice.",
  sections: [
    {
      heading: "Not financial advice",
      paragraphs: [
        "This site is a free educational tool for exploring retirement scenarios. It is not investment, tax, legal, accounting or retirement advice, and using it creates no advisory, fiduciary or professional relationship of any kind. It is not affiliated with, endorsed by, or acting on behalf of any financial institution.",
        "Nothing here is a recommendation to buy, sell or hold any security, to adopt any investment strategy, or to take any particular financial action. You should consult a suitably qualified professional who knows your circumstances before acting on anything you see here.",
      ],
    },
    {
      heading: "The model is deliberately simplified",
      paragraphs: [
        "Every figure the calculator shows is a projection generated from the assumptions you enter — not a prediction, a promise or a guarantee. The model assumes a single fixed rate of return with no market volatility and no sequence-of-returns risk; it models no taxes; and it treats property as a pure expense with no equity or resale value. Real outcomes will differ, potentially by a very large margin.",
        "Assumed or historical returns are not indicative of future results. Investing involves risk, including the possible loss of principal.",
      ],
    },
    {
      heading: "No warranty",
      paragraphs: [
        "This site and its output are provided “as is” and “as available”, without warranties or conditions of any kind, whether express or implied, including but not limited to warranties of accuracy, completeness, reliability, merchantability, fitness for a particular purpose and non-infringement. There is no guarantee that the site will be available, uninterrupted, error-free, or that any calculation is correct.",
      ],
    },
    {
      heading: "Limitation of liability",
      paragraphs: [
        "To the fullest extent permitted by applicable law, the authors and contributors accept no liability for any loss or damage of any kind — including direct, indirect, incidental, consequential, special or punitive damages, lost profits, or lost savings — arising out of or in connection with your use of, or reliance on, this site or its output, even if advised of the possibility of such damages.",
        "You are solely responsible for your own financial decisions and for verifying any figure that matters to you.",
      ],
    },
    {
      heading: "Acceptable use",
      paragraphs: [
        "You may use this tool freely for personal purposes. You may not use it unlawfully, misrepresent its output as professional advice, or present it to others as a guarantee of any financial outcome.",
      ],
    },
    {
      heading: "Acceptance",
      paragraphs: [
        "By using this site you accept these terms. If you do not accept them, please do not use the site.",
      ],
    },
  ],
};

export const LEGAL_PAGES = [PRIVACY, TERMS];
