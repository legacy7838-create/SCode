/* eslint-disable max-lines -- The suggestion corpus is maintained entry by entry in tabular form;
 * keeping it in one place makes side-by-side review easy.
 */
import finderIcon from "@/onboarding/assets/finder.png";
import terminalIcon from "@/onboarding/assets/terminal.png";
import feishuIcon from "@/onboarding/assets/feishu.png";
import documentsIcon from "@/assets/plugin-icons/documents.png";
import pdfIcon from "@/assets/plugin-icons/pdf.png";
import presentationsIcon from "@/assets/plugin-icons/presentations.png";
import spreadsheetsIcon from "@/assets/plugin-icons/spreadsheets.png";
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

const ASSETS = "https://cdn-zcode.z.ai/zcode/official-plugin/assets";

type FeatureRecommendedPrompt = DraftSuggestedPromptItem & {
  mode: "office" | "coding";
};

// This issue recommends hard pooling by mode; displaying copywriting and filling in text are maintained separately.
export const featureSuggestedPrompts: FeatureRecommendedPrompt[] = [
  {
    id: "feature-recvvsPdvcWQzF",
    mode: "office",
    iconUrl: terminalIcon,
    label: {
      cn: "Show what is using up space on my computer",
      en: "Show what is using up space on my computer",
    },
    prompt: {
      cn: "Analyze disk usage on this computer. Identify the largest directories and files, distinguish system files, application data, and personal files, and estimate what I could safely clean up. Do not delete any files.",
      en: "Analyze disk usage on this computer. Identify the largest directories and files, distinguish system files, application data, and personal files, and estimate what I could safely clean up. Do not delete any files.",
    },
  },
  {
    id: "feature-recvvsQoVaqVGC",
    mode: "office",
    iconUrl: `${ASSETS}/browser-use/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Send me a daily briefing on news I care about",
      en: "Send me a daily briefing on news I care about",
    },
    prompt: {
      cn: "Set up a scheduled task for 9 a.m. every day. Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to check accessible public news sites for important news about [topic of interest] from the past 24 hours, remove duplicates, and send me a brief digest. Include event and publication times, source links, and why each item matters. Say when there is no credible new item and do not repeat yesterday’s news.",
      en: "Set up a scheduled task for 9 a.m. every day. Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to check accessible public news sites for important news about [topic of interest] from the past 24 hours, remove duplicates, and send me a brief digest. Include event and publication times, source links, and why each item matters. Say when there is no credible new item and do not repeat yesterday’s news.",
    },
    plugin: {
      stableId: "browser-use@zcode-plugins-official",
      label: { cn: "Browser Use", en: "Browser Use" },
    },
  },
  {
    id: "feature-office-browser-business-reading",
    mode: "office",
    iconUrl: `${ASSETS}/browser-use/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Find three business stories worth reading today",
      en: "Find three business stories worth reading today",
    },
    prompt: {
      cn: "Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to browse publicly accessible business coverage from The Guardian and other international news sites. Open the full articles and pick three worth reading today. For each, give me the key information, why it is worth my time, the publication time, and the original link. Skip duplicate coverage, paywalled articles, and pages requiring sign-in. Recommend fewer than three if necessary.",
      en: "Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to browse publicly accessible business coverage from The Guardian and other international news sites. Open the full articles and pick three worth reading today. For each, give me the key information, why it is worth my time, the publication time, and the original link. Skip duplicate coverage, paywalled articles, and pages requiring sign-in. Recommend fewer than three if necessary.",
    },
    plugin: {
      stableId: "browser-use@zcode-plugins-official",
      label: { cn: "Browser Use", en: "Browser Use" },
    },
  },
  {
    id: "feature-office-browser-work-reading",
    mode: "office",
    iconUrl: `${ASSETS}/browser-use/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Find practical articles I can use at work",
      en: "Find practical articles I can use at work",
    },
    prompt: {
      cn: "Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to read recent, publicly accessible articles from Microsoft WorkLab and Atlassian Team Playbook. Pick three with concrete ideas for everyday work or collaboration. Read each page before explaining who it helps, what I could try, what to watch out for, and where to read the original. Do not recommend from titles alone or include pages that require sign-in or payment.",
      en: "Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to read recent, publicly accessible articles from Microsoft WorkLab and Atlassian Team Playbook. Pick three with concrete ideas for everyday work or collaboration. Read each page before explaining who it helps, what I could try, what to watch out for, and where to read the original. Do not recommend from titles alone or include pages that require sign-in or payment.",
    },
    plugin: {
      stableId: "browser-use@zcode-plugins-official",
      label: { cn: "Browser Use", en: "Browser Use" },
    },
  },
  {
    id: "feature-office-browser-economic-data",
    mode: "office",
    iconUrl: `${ASSETS}/browser-use/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Explain the latest economic data in plain language",
      en: "Explain the latest economic data in plain language",
    },
    prompt: {
      cn: "Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to review the latest publicly released OECD economic data. Choose three indicators relevant to consumers, employment, or business activity. Explain the reporting period, what changed, and why someone working in an office might care, with links to the original OECD releases. Separate reported facts from your interpretation and state the actual release dates if there is nothing new this week.",
      en: "Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to review the latest publicly released OECD economic data. Choose three indicators relevant to consumers, employment, or business activity. Explain the reporting period, what changed, and why someone working in an office might care, with links to the original OECD releases. Separate reported facts from your interpretation and state the actual release dates if there is nothing new this week.",
    },
    plugin: {
      stableId: "browser-use@zcode-plugins-official",
      label: { cn: "Browser Use", en: "Browser Use" },
    },
  },
  {
    id: "feature-recvvsPdvcUwzl",
    mode: "office",
    iconUrl: presentationsIcon,
    iconStyle: "plugin",
    label: {
      cn: "Create a presentation I can share",
      en: "Create a presentation I can share",
    },
    prompt: {
      cn: "Use [@Presentations](plugin://presentations@zcode-plugins-official) to create a shareable presentation about [topic]. Research public background, develop a clear argument and narrative, and produce slides with titles, conclusions, and sources. Label uncertain claims instead of inventing facts.",
      en: "Use [@Presentations](plugin://presentations@zcode-plugins-official) to create a shareable presentation about [topic]. Research public background, develop a clear argument and narrative, and produce slides with titles, conclusions, and sources. Label uncertain claims instead of inventing facts.",
    },
    plugin: {
      stableId: "presentations@zcode-plugins-official",
      label: { cn: "Presentations", en: "Presentations" },
    },
  },
  {
    id: "feature-recvvsPdvcA0k8",
    mode: "office",
    iconUrl: feishuIcon,
    label: {
      cn: "Review yesterday’s work and plan today automatically",
      en: "Review yesterday’s work and plan today automatically",
    },
    prompt: {
      cn: "Set up a scheduled task for 9 a.m. every workday. Use [@Lark CLI](plugin://lark-cli@zcode-plugins-official) to read my accessible calendar events, tasks, and work records from yesterday. Give me a brief daily report and the three most important things to do today. Only include claims supported by those records; tell me what to connect if access is missing.",
      en: "Set up a scheduled task for 9 a.m. every workday. Use [@Lark CLI](plugin://lark-cli@zcode-plugins-official) to read my accessible calendar events, tasks, and work records from yesterday. Give me a brief daily report and the three most important things to do today. Only include claims supported by those records; tell me what to connect if access is missing.",
    },
    plugin: {
      stableId: "lark-cli@zcode-plugins-official",
      label: { cn: "Lark CLI", en: "Lark CLI" },
    },
  },
  {
    id: "feature-recvvsS2usyGu7",
    mode: "office",
    iconUrl: `${ASSETS}/zcode-cua/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Review a website’s complete first-time user journey",
      en: "Review a website’s complete first-time user journey",
    },
    prompt: {
      cn: "Set up an idle-time task using [@Computer Use](plugin://computer-use@zcode-plugins-official) to open [target website] and act like a first-time user. Follow its main public journey from the home page to the step before final submission, documenting each step, confusion, blockers, and key screenshots. Produce a detailed UX report with evidence and prioritized improvements. Do not register, pay, or submit real information. If no local project is selected, ask me to choose one for the report.",
      en: "Set up an idle-time task using [@Computer Use](plugin://computer-use@zcode-plugins-official) to open [target website] and act like a first-time user. Follow its main public journey from the home page to the step before final submission, documenting each step, confusion, blockers, and key screenshots. Produce a detailed UX report with evidence and prioritized improvements. Do not register, pay, or submit real information. If no local project is selected, ask me to choose one for the report.",
    },
    plugin: {
      stableId: "computer-use@zcode-plugins-official",
      label: { cn: "Computer Use", en: "Computer Use" },
    },
  },
  {
    id: "feature-recvvsPdvcPqQQ",
    mode: "office",
    iconUrl: finderIcon,
    label: {
      cn: "Find what I should clean up in Downloads",
      en: "Find what I should clean up in Downloads",
    },
    prompt: {
      cn: "Inspect this computer’s Downloads folder for duplicates, old installers, and obvious temporary files. Rank the opportunities by space they could free and suggest an organization plan. Do not move or delete anything yet.",
      en: "Inspect this computer’s Downloads folder for duplicates, old installers, and obvious temporary files. Rank the opportunities by space they could free and suggest an organization plan. Do not move or delete anything yet.",
    },
  },
  {
    id: "feature-recvvsPdvcgq6k",
    mode: "office",
    iconUrl: pdfIcon,
    iconStyle: "plugin",
    label: {
      cn: "Create a sourced PDF research report on a topic",
      en: "Create a sourced PDF research report on a topic",
    },
    prompt: {
      cn: "Use [@PDF](plugin://pdf@zcode-plugins-official) to create a shareable PDF research report on [research topic]. Find recent credible public sources, then cover the background, key facts, differing views, and open questions. Date and source important figures and include references. Mark claims without reliable evidence instead of inventing them.",
      en: "Use [@PDF](plugin://pdf@zcode-plugins-official) to create a shareable PDF research report on [research topic]. Find recent credible public sources, then cover the background, key facts, differing views, and open questions. Date and source important figures and include references. Mark claims without reliable evidence instead of inventing them.",
    },
    plugin: {
      stableId: "pdf@zcode-plugins-official",
      label: { cn: "PDF", en: "PDF" },
    },
  },
  {
    id: "feature-recvvsPdvciNsr",
    mode: "office",
    iconUrl: feishuIcon,
    label: {
      cn: "Summarize this week and prepare next week’s priorities",
      en: "Summarize this week and prepare next week’s priorities",
    },
    prompt: {
      cn: "Set up a scheduled task for 5 p.m. every Friday. Use [@Lark CLI](plugin://lark-cli@zcode-plugins-official) to review my accessible calendar, tasks, and work records for the week. Summarize what was completed, what is ongoing, and what needs my decision, then suggest three priorities for next week. Do not invent progress that the records do not support.",
      en: "Set up a scheduled task for 5 p.m. every Friday. Use [@Lark CLI](plugin://lark-cli@zcode-plugins-official) to review my accessible calendar, tasks, and work records for the week. Summarize what was completed, what is ongoing, and what needs my decision, then suggest three priorities for next week. Do not invent progress that the records do not support.",
    },
    plugin: {
      stableId: "lark-cli@zcode-plugins-official",
      label: { cn: "Lark CLI", en: "Lark CLI" },
    },
  },
  {
    id: "feature-recvvsPdvcsDgI",
    mode: "office",
    iconUrl: documentsIcon,
    iconStyle: "plugin",
    label: {
      cn: "Create an editable project proposal",
      en: "Create an editable project proposal",
    },
    prompt: {
      cn: "Use [@Documents](plugin://documents@zcode-plugins-official) to create an editable Word proposal for [project topic]. Cover users and their problem, options, work plan, milestones, risks, and open decisions. When business context is missing, label reasonable assumptions and list the three most useful details for me to add. Do not invent internal data.",
      en: "Use [@Documents](plugin://documents@zcode-plugins-official) to create an editable Word proposal for [project topic]. Cover users and their problem, options, work plan, milestones, risks, and open decisions. When business context is missing, label reasonable assumptions and list the three most useful details for me to add. Do not invent internal data.",
    },
    plugin: {
      stableId: "documents@zcode-plugins-official",
      label: { cn: "Documents", en: "Documents" },
    },
  },
  {
    id: "feature-recvvsPdvcSvEZ",
    mode: "office",
    iconUrl: spreadsheetsIcon,
    iconStyle: "plugin",
    label: {
      cn: "Create a ready-to-use monthly income and expense tracker",
      en: "Create a ready-to-use monthly income and expense tracker",
    },
    prompt: {
      cn: "Use [@Spreadsheets](plugin://spreadsheets@zcode-plugins-official) to create an editable Excel monthly income and expense tracker I can start using right away. Let each entry capture its date, income or expense type, category, amount, and note. Include common categories and automatic monthly and category totals, including income, expenses, and balance. Add a few clearly marked example entries to show how it works, but exclude them from real totals. Do not ask for my financial details before creating the template.",
      en: "Use [@Spreadsheets](plugin://spreadsheets@zcode-plugins-official) to create an editable Excel monthly income and expense tracker I can start using right away. Let each entry capture its date, income or expense type, category, amount, and note. Include common categories and automatic monthly and category totals, including income, expenses, and balance. Add a few clearly marked example entries to show how it works, but exclude them from real totals. Do not ask for my financial details before creating the template.",
    },
    plugin: {
      stableId: "spreadsheets@zcode-plugins-official",
      label: { cn: "Spreadsheets", en: "Spreadsheets" },
    },
  },
  {
    id: "feature-recvvsPdvcK0EZ",
    mode: "office",
    iconUrl: terminalIcon,
    label: {
      cn: "Find out why my computer feels slow",
      en: "Find out why my computer feels slow",
    },
    prompt: {
      cn: "Check current resource use on this computer and identify processes, disk pressure, or memory pressure that may explain why it feels slow. Separate what you can observe from possible causes, and suggest safe first steps. Do not terminate processes or change system settings.",
      en: "Check current resource use on this computer and identify processes, disk pressure, or memory pressure that may explain why it feels slow. Separate what you can observe from possible causes, and suggest safe first steps. Do not terminate processes or change system settings.",
    },
  },
  {
    id: "feature-recvvsPdvclWR1",
    mode: "office",
    iconUrl: `${ASSETS}/zcode-cua/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "File my downloaded screenshots by month",
      en: "File my downloaded screenshots by month",
    },
    prompt: {
      cn: "Use [@Computer Use](plugin://computer-use@zcode-plugins-official) to open this computer’s file manager and sort screenshots in Downloads by month. Show me which files would move and where; after I approve, file them in batches. Leave other images alone and do not delete files.",
      en: "Use [@Computer Use](plugin://computer-use@zcode-plugins-official) to open this computer’s file manager and sort screenshots in Downloads by month. Show me which files would move and where; after I approve, file them in batches. Leave other images alone and do not delete files.",
    },
    plugin: {
      stableId: "computer-use@zcode-plugins-official",
      label: { cn: "Computer Use", en: "Computer Use" },
    },
  },
  {
    id: "feature-recvvsV4e4aOFp",
    mode: "office",
    iconUrl: `${ASSETS}/wind/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "See what has changed in an industry with Wind",
      en: "See what has changed in an industry with Wind",
    },
    prompt: {
      cn: "I want to understand changes in [target industry] over the past three months. Use connected [@Wind](plugin://wind@zcode-plugins-official) data to review key indicators, major events, and research views. Explain the direction of change, data dates, and sources in a concise industry brief. If Wind is unavailable, describe the gap rather than substituting another source without saying so.",
      en: "I want to understand changes in [target industry] over the past three months. Use connected [@Wind](plugin://wind@zcode-plugins-official) data to review key indicators, major events, and research views. Explain the direction of change, data dates, and sources in a concise industry brief. If Wind is unavailable, describe the gap rather than substituting another source without saying so.",
    },
    plugin: {
      stableId: "wind@zcode-plugins-official",
      label: { cn: "Wind", en: "Wind" },
    },
  },
  {
    id: "feature-recvvsV4e4bCq1",
    mode: "office",
    iconUrl: `${ASSETS}/wind/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Review a company’s operating and market performance",
      en: "Review a company’s operating and market performance",
    },
    prompt: {
      cn: "Research [target company] over the past four quarters using connected [@Wind](plugin://wind@zcode-plugins-official) data. Summarize available revenue, profit, and cash-flow metrics. If it is listed, add one year of market performance and relevant peers. State periods, definitions, and sources; separate facts, analysis, and open questions.",
      en: "Research [target company] over the past four quarters using connected [@Wind](plugin://wind@zcode-plugins-official) data. Summarize available revenue, profit, and cash-flow metrics. If it is listed, add one year of market performance and relevant peers. State periods, definitions, and sources; separate facts, analysis, and open questions.",
    },
    plugin: {
      stableId: "wind@zcode-plugins-official",
      label: { cn: "Wind", en: "Wind" },
    },
  },
  {
    id: "feature-recvvsV4e4ivrd",
    mode: "office",
    iconUrl: `${ASSETS}/hexin/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Compare leading companies in an industry",
      en: "Compare leading companies in an industry",
    },
    prompt: {
      cn: "Help me understand the main companies in [target industry]. Use connected [@RoyalFlush iFinD](plugin://hexin@zcode-plugins-official) data to compare three to five representative companies on recent growth, profitability, cash flow, and available valuation metrics. Explain differences and anomalies, show dates and sources, leave missing values blank, and avoid buy or sell advice.",
      en: "Help me understand the main companies in [target industry]. Use connected [@RoyalFlush iFinD](plugin://hexin@zcode-plugins-official) data to compare three to five representative companies on recent growth, profitability, cash flow, and available valuation metrics. Explain differences and anomalies, show dates and sources, leave missing values blank, and avoid buy or sell advice.",
    },
    plugin: {
      stableId: "hexin@zcode-plugins-official",
      label: { cn: "RoyalFlush iFinD", en: "RoyalFlush iFinD" },
    },
  },
  {
    id: "feature-recvvsV4e4g9yq",
    mode: "office",
    iconUrl: `${ASSETS}/hexin/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Summarize a company’s important recent filings",
      en: "Summarize a company’s important recent filings",
    },
    prompt: {
      cn: "Use connected [@RoyalFlush iFinD](plugin://hexin@zcode-plugins-official) to review [target company] announcements from the past 90 days. Build a timeline of important facts, figures, and questions to verify, with filing dates and original links. Do not present speculation as confirmed company plans.",
      en: "Use connected [@RoyalFlush iFinD](plugin://hexin@zcode-plugins-official) to review [target company] announcements from the past 90 days. Build a timeline of important facts, figures, and questions to verify, with filing dates and original links. Do not present speculation as confirmed company plans.",
    },
    plugin: {
      stableId: "hexin@zcode-plugins-official",
      label: { cn: "RoyalFlush iFinD", en: "RoyalFlush iFinD" },
    },
  },
  {
    id: "feature-recvvsV4e4AtLY",
    mode: "office",
    iconUrl: `${ASSETS}/tianyancha/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Check a company’s ownership and business risks",
      en: "Check a company’s ownership and business risks",
    },
    prompt: {
      cn: "Use connected [@Tianyancha](plugin://tianyancha@zcode-plugins-official) to review [target company] before I contact it. Verify the legal entity, registration status, key shareholders, controlling parties, investments, and available business or legal risk records. Provide a concise due-diligence checklist with source dates. Do not treat a risk record alone as proof of wrongdoing.",
      en: "Use connected [@Tianyancha](plugin://tianyancha@zcode-plugins-official) to review [target company] before I contact it. Verify the legal entity, registration status, key shareholders, controlling parties, investments, and available business or legal risk records. Provide a concise due-diligence checklist with source dates. Do not treat a risk record alone as proof of wrongdoing.",
    },
    plugin: {
      stableId: "tianyancha@zcode-plugins-official",
      label: { cn: "Tianyancha", en: "Tianyancha" },
    },
  },
  {
    id: "feature-recvvsV4e4Hsa3",
    mode: "office",
    iconUrl: `${ASSETS}/tianyancha/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Map a company’s related entities and key people",
      en: "Map a company’s related entities and key people",
    },
    prompt: {
      cn: "Use connected [@Tianyancha](plugin://tianyancha@zcode-plugins-official) to map shareholders, investments, branches, and key people for [target company]. Verify the legal entity first, distinguish direct from indirect links, and provide a relationship list with evidence, update dates, and points requiring manual confirmation.",
      en: "Use connected [@Tianyancha](plugin://tianyancha@zcode-plugins-official) to map shareholders, investments, branches, and key people for [target company]. Verify the legal entity first, distinguish direct from indirect links, and provide a relationship list with evidence, update dates, and points requiring manual confirmation.",
    },
    plugin: {
      stableId: "tianyancha@zcode-plugins-official",
      label: { cn: "Tianyancha", en: "Tianyancha" },
    },
  },
  {
    id: "feature-recvvsV4e4FqWU",
    mode: "office",
    iconUrl: `${ASSETS}/wind/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Research a company across three data sources",
      en: "Research a company across three data sources",
    },
    prompt: {
      cn: "Help me understand [target company]. Cross-check connected [@Wind](plugin://wind@zcode-plugins-official), [@RoyalFlush iFinD](plugin://hexin@zcode-plugins-official), and [@Tianyancha](plugin://tianyancha@zcode-plugins-official) for operating and market data, recent filings, company relationships, and risks. Write a concise report, preserve conflicting figures with their dates and definitions, and say which sources were unavailable.",
      en: "Help me understand [target company]. Cross-check connected [@Wind](plugin://wind@zcode-plugins-official), [@RoyalFlush iFinD](plugin://hexin@zcode-plugins-official), and [@Tianyancha](plugin://tianyancha@zcode-plugins-official) for operating and market data, recent filings, company relationships, and risks. Write a concise report, preserve conflicting figures with their dates and definitions, and say which sources were unavailable.",
    },
  },
  {
    id: "feature-coding-repo-start",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "Help me understand and run this repository",
      en: "Help me understand and run this repository",
    },
    prompt: {
      cn: "Help me understand what the open repository does, where its main features live, and how to run it on this computer. Try one core workflow, then give me a concise guide with key files, what ran successfully, and any blockers. If no repository is open, ask me to select one.",
      en: "Help me understand what the open repository does, where its main features live, and how to run it on this computer. Try one core workflow, then give me a concise guide with key files, what ran successfully, and any blockers. If no repository is open, ask me to select one.",
    },
  },
  {
    id: "feature-coding-branch-review",
    mode: "coding",
    iconUrl: `${ASSETS}/gitlab/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Check this branch before I submit it",
      en: "Check this branch before I submit it",
    },
    prompt: {
      cn: "Review the changes on the current branch of the open repository before I submit them. Identify the target branch, then look for concrete bugs, compatibility risks, and missed edge cases in the affected features. Rank findings by severity with code locations, triggers, and suggestions. If nothing is confirmed, tell me what was checked and what still needs verification.",
      en: "Review the changes on the current branch of the open repository before I submit them. Identify the target branch, then look for concrete bugs, compatibility risks, and missed edge cases in the affected features. Rank findings by severity with code locations, triggers, and suggestions. If nothing is confirmed, tell me what was checked and what still needs verification.",
    },
  },
  {
    id: "feature-coding-check-failures",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "Run the existing checks and diagnose failures",
      en: "Run the existing checks and diagnose failures",
    },
    prompt: {
      cn: "Check whether the open repository’s existing code checks and tests pass. Run the checks already configured and feasible in this environment. For failures, identify likely causes, separate issues introduced by this branch from existing ones, and suggest actionable fixes. Do not call unrun checks passes or make broad code changes yet.",
      en: "Check whether the open repository’s existing code checks and tests pass. Run the checks already configured and feasible in this environment. For failures, identify likely causes, separate issues introduced by this branch from existing ones, and suggest actionable fixes. Do not call unrun checks passes or make broad code changes yet.",
    },
  },
  {
    id: "feature-coding-mr-summary",
    mode: "coding",
    iconUrl: `${ASSETS}/gitlab/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Draft a merge request description for this branch",
      en: "Draft a merge request description for this branch",
    },
    prompt: {
      cn: "Draft a merge request description from this branch’s actual changes against its target branch. Cover the purpose, user-visible behavior, main implementation, verification results, and known risks. Mark checks that were not run as unverified. Ask me if the target branch is unclear. Show me the draft without publishing the MR.",
      en: "Draft a merge request description from this branch’s actual changes against its target branch. Cover the purpose, user-visible behavior, main implementation, verification results, and known risks. Mark checks that were not run as unverified. Ask me if the target branch is unclear. Show me the draft without publishing the MR.",
    },
  },
  {
    id: "feature-coding-dependencies",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "Review this repository’s dependencies and upgrade risks",
      en: "Review this repository’s dependencies and upgrade risks",
    },
    prompt: {
      cn: "Review the open repository’s main dependencies for outdated packages, confirmed security risks, and likely upgrade blockers. Consider how this project actually uses them, then give me a prioritized list with impact, evidence, and a suggested upgrade order. Do not treat age alone as a defect or upgrade everything yet.",
      en: "Review the open repository’s main dependencies for outdated packages, confirmed security risks, and likely upgrade blockers. Consider how this project actually uses them, then give me a prioritized list with impact, evidence, and a suggested upgrade order. Do not treat age alone as a defect or upgrade everything yet.",
    },
  },
  {
    id: "feature-recvvsWf8gXmsB",
    mode: "coding",
    iconUrl: `${ASSETS}/github/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Run a thorough test coverage review of a repository",
      en: "Run a thorough test coverage review of a repository",
    },
    prompt: {
      cn: "Set up an idle-time task for the local [target repository]. Review coverage of important features, run unit, integration, and end-to-end tests that the environment supports, add tests for important gaps, and rerun them. Deliver a detailed report of coverage, passes, failures, tests that could not run, evidence, and remaining risks. Never call an unrun test a pass. Ask me to select the repository if it is not open.",
      en: "Set up an idle-time task for the local [target repository]. Review coverage of important features, run unit, integration, and end-to-end tests that the environment supports, add tests for important gaps, and rerun them. Deliver a detailed report of coverage, passes, failures, tests that could not run, evidence, and remaining risks. Never call an unrun test a pass. Ask me to select the repository if it is not open.",
    },
  },
  {
    id: "feature-recvvsWf8g0Cg0",
    mode: "coding",
    iconUrl: `${ASSETS}/github/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Read a repository deeply and map its features",
      en: "Read a repository deeply and map its features",
    },
    prompt: {
      cn: "Set up an idle-time task for the local [target repository]. Map the main features, module responsibilities, data flows, and paths from entry point to result. Read the relevant code and docs, identify dependencies and confusing boundaries, and deliver a repository guide with file references. Label claims without code evidence as inference. Ask me to select the repository if it is not open.",
      en: "Set up an idle-time task for the local [target repository]. Map the main features, module responsibilities, data flows, and paths from entry point to result. Read the relevant code and docs, identify dependencies and confusing boundaries, and deliver a repository guide with file references. Label claims without code evidence as inference. Ask me to select the repository if it is not open.",
    },
  },
  {
    id: "feature-recvvsWf8grDkJ",
    mode: "coding",
    iconUrl: `${ASSETS}/github/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Find significant issues across a repository",
      en: "Find significant issues across a repository",
    },
    prompt: {
      cn: "Set up an idle-time task for the local [target repository]. Review important user journeys and cross-module calls for functional, compatibility, or data-loss issues. Reproduce high-risk findings where possible, check relevant tests, and deliver a detailed severity-ranked report with triggers, code locations, evidence, suggested fixes, and unverified hypotheses. Avoid broad code changes. Ask me to select the repository if it is not open.",
      en: "Set up an idle-time task for the local [target repository]. Review important user journeys and cross-module calls for functional, compatibility, or data-loss issues. Reproduce high-risk findings where possible, check relevant tests, and deliver a detailed severity-ranked report with triggers, code locations, evidence, suggested fixes, and unverified hypotheses. Avoid broad code changes. Ask me to select the repository if it is not open.",
    },
  },
  {
    id: "feature-coding-browser-deployed",
    mode: "coding",
    iconUrl: `${ASSETS}/browser-use/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Check a deployed website for obvious problems",
      en: "Check a deployed website for obvious problems",
    },
    prompt: {
      cn: "Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to open [test URL] and check its navigation, main entry points, and one flow available without signing in. Report broken pages, controls, content, or layout with reproduction steps, URLs, and screenshots. Do not register, pay, or submit real information; mark signed-in areas as not covered.",
      en: "Use [@Browser Use](plugin://browser-use@zcode-plugins-official) to open [test URL] and check its navigation, main entry points, and one flow available without signing in. Report broken pages, controls, content, or layout with reproduction steps, URLs, and screenshots. Do not register, pay, or submit real information; mark signed-in areas as not covered.",
    },
    plugin: {
      stableId: "browser-use@zcode-plugins-official",
      label: { cn: "Browser Use", en: "Browser Use" },
    },
  },
  {
    id: "feature-coding-scheduled-ci",
    mode: "coding",
    iconUrl: `${ASSETS}/gitlab/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Check this repository for new CI failures daily",
      en: "Check this repository for new CI failures daily",
    },
    prompt: {
      cn: "Set up a scheduled task for 9 a.m. every workday for the open repository. Check its remote CI for failures newly seen in the past 24 hours. Report only failures that still need attention, with the pipeline or job, branch and commit, error evidence, and a next step. Give a brief all-clear if there are none. Tell me before creating the task if the repository has no remote CI or the scheduled environment cannot access it.",
      en: "Set up a scheduled task for 9 a.m. every workday for the open repository. Check its remote CI for failures newly seen in the past 24 hours. Report only failures that still need attention, with the pipeline or job, branch and commit, error evidence, and a next step. Give a brief all-clear if there are none. Tell me before creating the task if the repository has no remote CI or the scheduled environment cannot access it.",
    },
  },
  {
    id: "feature-coding-scheduled-weekly-changes",
    mode: "coding",
    iconUrl: `${ASSETS}/gitlab/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Summarize this repository’s changes and risks weekly",
      en: "Summarize this repository’s changes and risks weekly",
    },
    prompt: {
      cn: "Set up a scheduled task for 5 p.m. every Friday for the open repository. Review changes merged this week and failures or blockers still open. Send me a short update grouped by feature changes, verification, and risks to watch next week, with commit, merge request, or CI links. Do not call unmerged work complete. Tell me before creating the task if its environment cannot access the repository or remote.",
      en: "Set up a scheduled task for 5 p.m. every Friday for the open repository. Review changes merged this week and failures or blockers still open. Send me a short update grouped by feature changes, verification, and risks to watch next week, with commit, merge request, or CI links. Do not call unmerged work complete. Tell me before creating the task if its environment cannot access the repository or remote.",
    },
  },
  {
    id: "feature-coding-idle-external-failures",
    mode: "coding",
    iconUrl: `${ASSETS}/github/icon.png`,
    iconStyle: "plugin",
    label: {
      cn: "Deeply review external-service failure paths in idle time",
      en: "Deeply review external-service failure paths in idle time",
    },
    prompt: {
      cn: "Set up an idle-time task for the open local repository. Trace how timeouts, disconnections, rate limits, and errors from external APIs, databases, and third-party services affect important user flows. Follow each path to the caller and user-visible result, reproduce high-risk gaps where feasible, and deliver a severity-ranked report with code locations, runtime evidence, and fixes. Do not present unverified risks as incidents or make broad code changes. Ask me to select a local repository if none is open.",
      en: "Set up an idle-time task for the open local repository. Trace how timeouts, disconnections, rate limits, and errors from external APIs, databases, and third-party services affect important user flows. Follow each path to the caller and user-visible result, reproduce high-risk gaps where feasible, and deliver a severity-ranked report with code locations, runtime evidence, and fixes. Do not present unverified risks as incidents or make broad code changes. Ask me to select a local repository if none is open.",
    },
  },
];

export function getRecommendedPromptPool(isOfficeMode: boolean): DraftSuggestedPromptItem[] {
  const mode = isOfficeMode ? "office" : "coding";
  return featureSuggestedPrompts.filter((item) => item.mode === mode);
}
