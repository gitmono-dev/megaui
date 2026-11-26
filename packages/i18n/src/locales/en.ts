// megaui:libs/i18n/locales/en.ts@0ff3a9d
//
// Upstream key names kept where retained (see README "Provenance" and
// "Removed namespaces" tables for the full diff). All values below are
// rewritten to brand-neutral copy for Mega — no upstream product name
// appears in any translation value.
import type { Locale } from './types'

export const en = {
  common: {
    welcome: "Welcome to Mega",
    siteName: "Mega",
    login: "Login",
    signup: "Sign Up",
    logout: "Logout",
    profile: "Profile",
    settings: "Settings",
    and: "and",
    loading: "Loading...",
    unexpectedError: "Something went wrong. Please try again.",
    notAvailable: "N/A",
    yes: "Yes",
    no: "No",
    theme: {
      light: "Light Theme",
      dark: "Dark Theme",
      system: "System Theme",
      toggle: "Toggle Theme",
      appearance: "Appearance",
      colorScheme: "Color Scheme"
    }
  },
  actions: {
    save: "Save",
    cancel: "Cancel",
    confirm: "Confirm",
    delete: "Delete",
    edit: "Edit",
    tryAgain: "Try again",
    createAccount: "Create account",
    sendCode: "Send Code",
    verify: "Verify",
    saveChanges: "Save Changes",
    back: "Back",
    resendCode: "Resend Code",
    resendVerificationEmail: "Resend verification email",
    upload: "Upload",
    previous: "Previous",
    next: "Next"
  },
  email: {
    verification: {
      subject: "Verify your Mega account",
      title: "Confirm your email address",
      greeting: "Hello {{name}},",
      message: "Thank you for creating a Mega account. To finish setting up your account, please click the button below to verify your email address.",
      button: "Verify Email Address",
      alternativeText: "Prefer to paste a link? Copy this address into your browser:",
      expiry: "The link stays valid for {{expiry_hours}} hours.",
      disclaimer: "You can ignore this message if you did not ask for this verification.",
      signature: "The Mega Team",
      copyright: "© {{year}} Mega. All rights reserved."
    },
    resetPassword: {
      subject: "Reset your Mega password",
      title: "Reset your password",
      greeting: "Hello {{name}},",
      message: "A request was made to change the password on your account. Use the button below to choose a new one. If this wasn't you, simply disregard this message.",
      button: "Reset Password",
      alternativeText: "Prefer to paste a link? Copy this address into your browser:",
      expiry: "The link stays valid for {{expiry_hours}} hours.",
      disclaimer: "If you did not ask for a password reset, there is nothing you need to do.",
      signature: "The Mega Team",
      copyright: "© {{year}} Mega. All rights reserved."
    }
  },
  auth: {
    metadata: {
      signin: {
        title: "Mega - Sign In",
        description: "Sign in to your Mega account to access your workspace.",
        keywords: "sign in, login, authentication, account access, workspace"
      },
      signup: {
        title: "Mega - Create Account",
        description: "Create your Mega account and start collaborating in your workspace.",
        keywords: "sign up, register, new account, join, onboarding"
      },
      forgotPassword: {
        title: "Mega - Reset Password",
        description: "Reset your Mega account password securely. Enter your email to receive password reset instructions.",
        keywords: "forgot password, password help, account recovery, reset link"
      },
      resetPassword: {
        title: "Mega - Create New Password",
        description: "Create a new secure password for your Mega account. Choose a strong password to protect your account.",
        keywords: "choose password, password change, account protection, credentials"
      },
    },
    signin: {
      title: "Sign in to your account",
      welcomeBack: "Welcome back",
      socialLogin: "Or sign in with a social account",
      continueWith: "Or continue with",
      email: "Email",
      emailPlaceholder: "you@example.com",
      password: "Password",
      forgotPassword: "Forgot your password?",
      rememberMe: "Remember me",
      submit: "Sign in",
      submitting: "Signing in...",
      noAccount: "New to Mega?",
      signupLink: "Sign up",
      termsNotice: "By continuing you accept our",
      termsOfService: "Terms of Service",
      privacyPolicy: "Privacy Policy",
      socialProviders: {
        google: "Google",
        github: "GitHub",
        apple: "Apple"
      },
      errors: {
        invalidEmail: "That doesn't look like a valid email address",
        requiredEmail: "Enter your email",
        requiredPassword: "Enter your password",
        invalidCredentials: "The email or password is incorrect",
        emailNotVerified: {
          title: "Please confirm your email first",
          description: "We sent a confirmation link to your inbox. Open it to continue, or request a fresh link below if it never arrived.",
          resendSuccess: "A new confirmation email is on its way. Check your inbox.",
          resendError: "We couldn't send the confirmation email. Please retry in a moment.",
          dialogTitle: "Send a new confirmation email",
          dialogDescription: "Please confirm to resend the verification email",
          emailLabel: "Email Address",
          sendButton: "Send confirmation email",
          sendingButton: "Sending...",
          waitButton: "Wait {seconds}s"
        }
      },
      feishu: {
        title: "Sign in with Feishu",
        description: "Enter your work email and we will send a sign-in code to your Feishu.",
        email: "Work email",
        emailPlaceholder: "name@company.com",
        request: "Send code",
        requesting: "Sending...",
        invalidEmail: "Enter a valid email address.",
        requestFailed: "The code could not be sent. Please try again.",
        codeSent: "If {email} belongs to a member, a sign-in code has been sent to your Feishu.",
        code: "Verification code",
        verifying: "Signing in...",
        verifyFailed: "Sign-in could not be completed. Please try again.",
        codeInvalid: "The code is invalid or has expired.",
        accountConflict: "This email is already used by another account on this site, so it cannot sign in with Feishu. Please contact your administrator.",
        codeRetry: "Sign-in could not be completed. Please request a new code.",
        resend: "Resend code",
        resendWait: "Resend in {seconds}s",
        codeResent: "A new code has been requested. Codes sent before it no longer work."
      }
    },
    signup: {
      title: "Create your account",
      createAccount: "Create your account",
      socialSignup: "Or sign up with a social account",
      continueWith: "Or continue with",
      name: "Name",
      namePlaceholder: "Your full name",
      email: "Email",
      emailPlaceholder: "you@example.com",
      username: "Username",
      usernamePlaceholder: "Choose a username",
      usernameHint: "Lowercase letters, numbers, and hyphens (2–31 characters)",
      password: "Password",
      passwordPlaceholder: "Pick a password",
      imageUrl: "Profile Image URL",
      imageUrlPlaceholder: "https://example.com/avatar.png",
      optional: "Optional",
      submit: "Create account",
      submitting: "Creating account...",
      haveAccount: "Already registered?",
      signinLink: "Sign in",
      termsNotice: "By continuing you accept our",
      termsOfService: "Terms of Service",
      privacyPolicy: "Privacy Policy",
      verification: {
        title: "Verification Required",
        sent: "A confirmation email has been sent to",
        checkSpam: "Nothing in your inbox? Look in the spam or junk folder.",
        spamInstruction: "Still missing? You can"
      },
      errors: {
        invalidName: "That name isn't valid",
        requiredName: "Name is required",
        invalidEmail: "That doesn't look like a valid email address",
        requiredEmail: "Enter your email",
        invalidUsername: "Please enter a valid username",
        requiredUsername: "Username is required",
        invalidPassword: "That password isn't valid",
        requiredPassword: "Enter a password",
        invalidImage: "Please enter a valid image URL"
      }
    },
    forgetPassword: {
      title: "Forgot Password",
      description: "Enter your email and we'll help you get back into your account",
      email: "Email",
      emailPlaceholder: "you@example.com",
      submit: "Send reset link",
      submitting: "Sending...",
      termsNotice: "By continuing you accept our",
      termsOfService: "Terms of Service",
      privacyPolicy: "Privacy Policy",
      verification: {
        title: "Check your email",
        sent: "A password reset link has been sent to",
        checkSpam: "Nothing in your inbox? Look in the spam or junk folder."
      },
      errors: {
        invalidEmail: "That doesn't look like a valid email address",
        requiredEmail: "Email is required"
      }
    },
    resetPassword: {
      title: "Reset Password",
      description: "Choose a new password for your account",
      password: "New Password",
      passwordPlaceholder: "New password",
      confirmPassword: "Repeat password",
      confirmPasswordPlaceholder: "Type the new password again",
      submit: "Reset Password",
      submitting: "Resetting...",
      success: {
        title: "Password updated",
        description: "Your password was changed.",
        backToSignin: "Back to Sign In",
        goToSignIn: "Back to Sign In"
      },
      errors: {
        invalidPassword: "Use at least 8 characters",
        requiredPassword: "Enter a password",
        passwordsDontMatch: "The two passwords differ",
        invalidToken: "This reset link is invalid or has expired. Request a new one."
      }
    },
    authErrors: {
      USER_NOT_FOUND: "No account found with this email",
      USER_ALREADY_EXISTS: "User with this email already exists",
      USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "User already exists. Please use another email",
      USER_EMAIL_NOT_FOUND: "User email not found",
      FAILED_TO_CREATE_USER: "Failed to create user",
      FAILED_TO_UPDATE_USER: "Failed to update user",
      INVALID_EMAIL: "Invalid email address",
      INVALID_PASSWORD: "Invalid password",
      INVALID_EMAIL_OR_PASSWORD: "Invalid email or password",
      INVALID_CREDENTIALS: "Invalid credentials provided",
      INVALID_TOKEN: "Invalid or expired token",
      PASSWORD_TOO_SHORT: "Password is too short",
      PASSWORD_TOO_LONG: "Password is too long",
      EMAIL_NOT_VERIFIED: "Please verify your email address",
      EMAIL_ALREADY_VERIFIED: "Email is already verified",
      EMAIL_MISMATCH: "Email mismatch",
      EMAIL_CAN_NOT_BE_UPDATED: "Email cannot be updated",
      VERIFICATION_EMAIL_NOT_ENABLED: "Verification email is not enabled",
      SESSION_EXPIRED: "Your session has expired. Please sign in again",
      SESSION_NOT_FRESH: "Session is not fresh. Please re-authenticate",
      FAILED_TO_CREATE_SESSION: "Failed to create session",
      FAILED_TO_GET_SESSION: "Failed to get session",
      ACCOUNT_NOT_FOUND: "Account not found",
      ACCOUNT_BLOCKED: "Your account has been temporarily blocked",
      CREDENTIAL_ACCOUNT_NOT_FOUND: "Credential account not found",
      SOCIAL_ACCOUNT_ALREADY_LINKED: "Social account is already linked",
      LINKED_ACCOUNT_ALREADY_EXISTS: "Linked account already exists",
      FAILED_TO_UNLINK_LAST_ACCOUNT: "Cannot unlink your last account",
      USER_ALREADY_HAS_PASSWORD: "User already has a password",
      PROVIDER_NOT_FOUND: "Provider not found",
      ID_TOKEN_NOT_SUPPORTED: "ID token not supported",
      FAILED_TO_GET_USER_INFO: "Failed to get user info",
      TOO_MANY_REQUESTS: "Too many requests. Please try again later",
      CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: "Cross-site navigation login blocked",
      INVALID_ORIGIN: "Invalid origin",
      MISSING_OR_NULL_ORIGIN: "Missing or invalid origin",
      INVALID_CALLBACK_URL: "Invalid callback URL",
      INVALID_REDIRECT_URL: "Invalid redirect URL",
      INVALID_ERROR_CALLBACK_URL: "Invalid error callback URL",
      INVALID_NEW_USER_CALLBACK_URL: "Invalid new user callback URL",
      CALLBACK_URL_REQUIRED: "Callback URL is required",
      VALIDATION_ERROR: "Validation error",
      MISSING_FIELD: "Required field is missing",
      FIELD_NOT_ALLOWED: "Field is not allowed",
      ASYNC_VALIDATION_NOT_SUPPORTED: "Async validation is not supported",
      FAILED_TO_CREATE_VERIFICATION: "Failed to create verification",
      EMAIL_SEND_FAILED: "Failed to send email. Please try again later",
      UNKNOWN_ERROR: "An unexpected error occurred"
    }
  },
  workspace: {
    metadata: {
      title: "Mega - Workspace",
      description: "Collaborate in your Mega workspace.",
      keywords: "workspace, collaboration, Mega"
    },
    title: "Workspace",
    description: "Your Mega workspace is ready.",
    images: { title: "Images", description: "Browse container image repositories in Mega2.", search: "Search repositories", searchTags: "Search tags", empty: "No image repositories found.", unavailable: "The image registry is unavailable or access is not enabled.", retry: "Retry", loading: "Loading images…", more: "Load more", back: "All repositories", tags: "Tags", noTags: "No tags found." },
    nav: {
      ariaLabel: "Mega workspace navigation",
      search: "Search",
      searchAriaLabel: "Search the Mega workspace",
      items: {
        home: "Home",
        inbox: "Inbox",
        docs: "Doc",
        agent: "Agent",
        code: "Code",
        tags: "Tag",
        cls: "Change List",
        issues: "Issue",
        images: "Images"
      },
      favorites: "Favorites",
      favoritesEmpty: "Favorite your top items — create or bookmark.",
      removeFavorite: "Remove {title} from favorites",
      addFavorite: "Add a favorite",
      channels: "Channels",
      addChannel: "Add a channel",
      newChannel: "New channel",
      noChannels: "No channels yet. Create one to start a conversation.",
      chat: "Chat",
      addChat: "Start a chat",
      newChat: "New chat",
      noChats: "No direct messages yet. Start a chat with a teammate.",
      loading: "Loading workspace navigation",
      loadError: "Workspace navigation is unavailable.",
      countsError: "Unread counts are unavailable.",
      retry: "Retry",
      unread: "unread",
      openChangeLists: "open change lists",
      mentions: "mentions",
      presence: {
        online: "online",
        away: "away",
        offline: "offline",
        busy: "busy"
      },
      currentUser: "Current user",
      openProfile: "Open profile settings",
      accountMenu: "Account menu",
      userLoading: "Loading user"
    },
    palette: {
      title: "Command palette",
      inputPlaceholder: "Search Mega or jump to…",
      empty: "No results found.",
      loading: "Searching…",
      error: "Search is unavailable. Try again shortly.",
      groups: {
        navigation: "Navigation",
        actions: "Quick actions",
        issues: "Issues",
        cls: "Change Lists",
        docs: "Docs",
        files: "Files",
        bodyDocs: "Doc content",
        bodyIssues: "Issue content",
        bodyCls: "CL content",
        bodyComments: "Comments",
        bodyMessages: "Messages"
      },
      bodyTypeBadge: {
        doc: "Doc",
        issue: "Issue",
        cl: "CL",
        doc_comment: "Doc comment",
        issue_comment: "Comment",
        cl_comment: "Comment",
        chat_message: "Message"
      },
      actions: {
        newCl: "New Change List",
        reportIssue: "Report an issue",
        askAgent: "Ask the Agent",
        writeDoc: "Write a doc"
      }
    },
    home: {
      greetings: {
        day: "Hello, {name}",
        morning: "Good morning, {name}",
        afternoon: "Good afternoon, {name}",
        evening: "Good evening, {name}"
      },
      fallbackName: "there",
      askAgent: "Ask Agent",
      newDoc: "New doc",
      loading: "Loading your workspace dashboard",
      error: "The dashboard is unavailable.",
      retry: "Retry",
      kpis: {
        reviewsRequested: "For my review",
        mentions: "@me",
        myOpenIssues: "My open issues",
        mainCI: "CI · main",
        agentSessions: "Agent sessions",
        sessionsToday: "{count} today",
        ci: {
          passing: "passing",
          failing: "failing",
          queued: "queued",
          running: "running",
          skipped: "skipped"
        }
      },
      cards: {
        reviewCls: {
          title: "CLs for my review",
          action: "All",
          empty: "No Change Lists are waiting for your review."
        },
        assignedIssues: {
          title: "Issues assigned to me",
          action: "All",
          empty: "No issues are assigned to you."
        },
        activity: {
          title: "Activity",
          action: "Inbox",
          empty: "No recent activity.",
          updated: "{actor} updated {ref}"
        },
        latestRelease: {
          title: "Latest release",
          action: "Tags",
          latest: "Latest",
          empty: "No releases yet."
        },
        agentSessions: {
          title: "Recent Agent sessions",
          action: "Agent",
          empty: "No Agent sessions yet."
        },
        recentDocs: {
          title: "Recent docs",
          action: "Docs",
          empty: "No documents yet."
        },
        activeChannels: {
          title: "Active channels",
          unread: "unread",
          empty: "No active channels."
        }
      }
    },
    code: {
      loading: "Loading the code root view",
      error: "The code view is unavailable.",
      retry: "Retry",
      readme: {
        title: "README"
      },
      header: {
        monorepoChip: "monorepo",
        publicChip: "public",
        branchSelectorAriaLabel: "Switch branch",
        starAriaLabel: "Star this workspace",
        starUnavailable: "Starring is unavailable while Code uses the mega2 backend.",
        unstarAriaLabel: "Unstar this workspace",
        packagesCount: "{count} packages",
        activeCls: "{count} active change lists",
        newCl: "New CL"
      },
      stats: {
        packages: "Packages",
        openCls: "Open CLs",
        openIssues: "Open Issues",
        contributors: "Contributors",
        mainCI: "CI · main",
        ci: {
          passing: "passing",
          failing: "failing",
          queued: "queued",
          running: "running",
          skipped: "skipped"
        }
      },
      table: {
        searchPlaceholder: "Search files, packages, symbols…",
        sortBy: "Sort by",
        sortName: "Name",
        sortUpdated: "Updated",
        pkgBadge: "pkg",
        empty: "This directory is empty.",
        columns: {
          name: "Name",
          lastChange: "Last change",
          owner: "Owner",
          updated: "Updated"
        }
      },
      quickLinks: {
        openClsTitle: "{count} open Change Lists",
        openIssuesTitle: "{count} open Issues",
        p1Count: "{count} P1",
        assignedToYou: "{count} assigned to you"
      },
      file: {
        treeAriaLabel: "Workspace file tree",
        notFoundTitle: "Path not found",
        notFoundBody: "\"{path}\" does not exist in this workspace.",
        backToCode: "Back to Code",
        contentUnavailable: "File content is unavailable.",
        contentPlaceholder: "File content renders here.",
        dir: {
          name: "Name",
          empty: "This directory is empty."
        },
        header: {
          breadcrumbAriaLabel: "File path breadcrumb",
          raw: "Raw",
          tabsAriaLabel: "File view tabs",
          tabs: {
            preview: "Preview",
            code: "Code",
            blame: "Blame",
            history: "History"
          },
          deferredTooltip: "Coming later — not part of this milestone",
          previewUnavailableTooltip: "Preview is only available for Markdown files",
          linesCount: "{count} lines",
          actionsAriaLabel: "File actions",
          copy: "Copy",
          copied: "Copied!",
          download: "Download",
          edit: "Edit",
          editTooltip: "Editing happens through a Change List",
          newCl: "New CL",
          contentUnavailable: "Content unavailable"
        }
      },
      outline: {
        ciTitle: "CI · main",
        ci: {
          passing: "passing",
          failing: "failing",
          queued: "queued",
          running: "running",
          skipped: "skipped"
        },
        ciDuration: "{minutes}m {seconds}s",
        owners: "Owners",
        flags: "Flags",
        sparseCheckout: "Sparse checkout",
        codexIndexed: "Codex indexed",
        enabled: "enabled",
        ready: "ready",
        off: "off",
        dependencies: "Dependencies",
        usedBy: "Used by",
        outline: "Outline",
        openCls: "Open CLs",
        recentActivity: "Recent activity",
        updatedActivity: "{actor} updated {ref}",
        noPackage: "This path does not belong to a package.",
        noData: "—",
        loadError: "Change Lists are unavailable.",
        retry: "Retry"
      }
    },
    tags: {
      title: "Tags",
      subtitle: "Releases · git tag",
      loading: "Loading releases",
      error: "Releases are unavailable.",
      retry: "Retry",
      viewAriaLabel: "Tags view",
      viewReleases: "Releases",
      viewTags: "Tags",
      draftRelease: "Draft release",
      draftDate: "Draft",
      pillLatest: "Latest",
      pillPrerelease: "Pre-release",
      pillMajor: "Major",
      card: {
        draft: "DRAFT",
        commitsSince: "{count} commits since {since}",
        compare: "Compare",
        assets: {
          title: "Assets",
          name: "Asset",
          size: "Size",
          downloads: "Downloads",
          downloadAriaLabel: "Download {name}"
        }
      },
      flat: {
        tableAriaLabel: "Tags",
        tag: "Tag",
        sha: "SHA",
        date: "Date"
      },
      draftDialog: {
        title: "Draft a release",
        tagLabel: "Tag",
        tagPlaceholder: "v0.4.3",
        titleLabel: "Title",
        titlePlaceholder: "git-internal 0.4.3",
        notesLabel: "Release notes",
        notesPlaceholder: "What changed? Use !1208 for CL refs…",
        cancel: "Cancel",
        submit: "Create draft",
        submitting: "Creating…",
        genericError: "Could not create the draft."
      },
      publish: "Publish",
      publishSuccess: "Release published",
      publishConflict: "This release was already published",
      publishError: "Could not publish the release"
    },
    session: {
      loading: "Loading session",
      notFound: "This session does not exist or is unavailable.",
      retry: "Retry",
      header: {
        breadcrumbAriaLabel: "Session breadcrumb",
        completed: "completed",
        running: "running",
        pipeNote: "libra → mega · refs/ai/",
        export: "Export objects",
        deferredTooltip: "Coming later (out of scope for this milestone)"
      },
      timeline: {
        timelineAriaLabel: "Object timeline",
        title: "Object graph · {count}",
        layerSnapshot: "Snapshot",
        layerEvent: "Event",
        layerLibra: "Libra"
      },
      detail: {
        immutableNote: "immutable snapshot · content-addressed",
        chainNote: "run_id → task_id → plan_id → intent_id",
        touched: "touched",
        format: "format",
        json: {
          title: "object body",
          copyAriaLabel: "Copy the object body JSON",
          copied: "Copied"
        }
      },
      rail: {
        sectionScheduler: "Scheduler [L]",
        sectionProvenance: "Provenance [S]",
        sectionRunUsage: "RunUsage [E]",
        sectionDecision: "Decision [E]",
        sectionEvidence: "Evidence [E]",
        sectionOutputs: "Outputs",
        outputCLAriaLabel: "Open the produced change list",
        copyRefAriaLabel: "Copy the thread ref",
        copiedRef: "Copied"
      }
    },
    agent: {
      loading: "Loading Agent",
      notFound: "This conversation does not exist or is unavailable.",
      retry: "Retry",
      askError: "The Agent could not answer. Please retry.",
      streamError: "The Agent stream was interrupted. Please retry.",
      llmDisabledTitle: "Agent LLM is not configured",
      llmDisabledBody: "Configure an LLM provider to ask the workspace agent. Threads remain available to browse.",
      searching: "Searching {scope} …",
      rail: {
        railAriaLabel: "Agent conversations",
        newThread: "New conversation",
        recent: "Recent",
        untitled: "New conversation"
      },
      header: {
        title: "Mega Agent",
        indexLine: "{count} packages indexed · Codex updated",
        scope: "scope",
        scopeAriaLabel: "Retrieval scope",
        allPackages: "all packages",
        deferredTooltip: "Coming later (out of scope for this milestone)"
      },
      answer: {
        copy: "Copy",
        copied: "Copied",
        helpful: "Helpful",
        regenerate: "Regenerate"
      },
      composer: {
        placeholder: "Ask Mega Agent anything about code, CLs or architecture…",
        inputAriaLabel: "Agent question",
        sendAriaLabel: "Send the question",
        suggestedAriaLabel: "Suggested prompts",
        provenanceNote: "Codex retrieval · citations are traceable",
        addChipAriaLabel: "Add a file context chip",
        addChipPlaceholder: "path/to/file.rs",
        removeChipAriaLabel: "Remove context chip {chip}"
      },
      sources: {
        panelAriaLabel: "Sources and scope",
        sectionCitations: "Citations this turn",
        noCitations: "Citations appear here once an answer completes.",
        sectionScope: "Retrieval scope",
        indexed: "indexed",
        optional: "optional",
        scopeHint: "Covers main-branch code, CL diffs, Docs and Issues.",
        sectionActions: "Quick actions",
        actionCreateCL: "Create CL from answer",
        actionCreateIssue: "Create issue",
        actionSaveDoc: "Save as doc",
        actionShare: "Share conversation",
        deferredTooltip: "Coming later (out of scope for this milestone)"
      }
    },
    chat: {
      loading: "Loading channel",
      notFound: "This channel does not exist or is unavailable.",
      retry: "Retry",
      sendError: "The message could not be sent.",
      editError: "The message could not be edited.",
      reactionError: "The reaction could not be saved.",
      markAsRead: "Mark as read",
      jumpToMention: "Jump to mention",
      typingAriaLabel: "{name} is typing",
      intro: "This is the start of {name}. Every package mounts a channel automatically — messages can reference CLs, commits and symbols.",
      roleApp: "app",
      roleOwner: "owner",
      states: {
        wip: "WIP",
        ready: "ready",
        queued: "queued",
        conflicts: "conflicts",
        merged: "merged",
        closed: "closed"
      },
      header: {
        deferredTooltip: "Coming later (out of scope for this milestone)",
        membersAriaLabel: "Channel members",
        memberCountAriaLabel: "{count} members",
        privateBadge: "Private",
        openMembersAriaLabel: "Open channel members"
      },
      members: {
        title: "Members",
        close: "Close",
        empty: "No members yet",
        inviteHeading: "Invite people",
        inviteSearchPlaceholder: "Search workspace users",
        inviteButton: "Invite",
        inviteEmpty: "No matching users",
        remove: "Remove",
        leave: "Leave",
        roleAdmin: "admin",
        roleMember: "member",
        privateBadge: "Private",
        inviteError: "Could not invite that user",
        removeError: "Could not update membership"
      },
      create: {
        title: "Create a channel",
        nameLabel: "Name",
        topicLabel: "Topic (optional)",
        visibilityLabel: "Visibility",
        visibilityPublic: "Public",
        visibilityPrivate: "Private",
        submit: "Create channel",
        error: "Could not create the channel"
      },
      tabs: {
        tabsAriaLabel: "Channel views",
        messages: "Messages",
        cls: "CLs",
        files: "Files",
        pinned: "Pinned",
        about: "About",
        deferredTooltip: "Coming later (out of scope for this milestone)"
      },
      list: {
        listAriaLabel: "Messages",
        jumpToLatest: "Jump to latest",
        threadReplies: "{count} replies",
        threadLastReply: "last reply",
        edited: "(edited)",
        edit: "Edit",
        cancelEdit: "Cancel",
        saveEdit: "Save",
        day: {
          today: "Today",
          yesterday: "Yesterday"
        }
      },
      composer: {
        placeholder: "Message #{name} — use @ to mention, ! to reference a CL",
        inputAriaLabel: "Message input",
        sendAriaLabel: "Send the message",
        sendHint: "⌘Enter to send",
        cmdEnterHint: "⌘/Ctrl+Enter to send",
        attachCL: "Attach CL",
        deferredTooltip: "Coming later (out of scope for this milestone)",
        lookupUsersAriaLabel: "Mention suggestions",
        lookupClsAriaLabel: "CL suggestions",
        edited: "(edited)",
        edit: "Edit",
        saveEdit: "Save",
        cancelEdit: "Cancel",
        format: {
          ariaLabel: "Text formatting",
          bold: "Bold",
          italic: "Italic",
          strikethrough: "Strikethrough",
          code: "Inline code",
          link: "Link",
          linkPlaceholder: "https://…"
        },
        slashMenu: {
          ariaLabel: "Insert block",
          heading1: "Heading 1",
          heading2: "Heading 2",
          heading3: "Heading 3",
          unorderedList: "Bulleted list",
          orderedList: "Numbered list",
          checklist: "Checklist",
          quote: "Quote",
          code: "Code block",
          table: "Table",
          divider: "Divider"
        },
        wikilinks: {
          ariaLabel: "Link suggestions",
          createPage: "Create \"{title}\"",
          empty: "No matching pages"
        }
      },
      dm: {
        notFound: "This conversation does not exist or is unavailable.",
        readReceipt: "Read",
        typingAriaLabel: "{name} is typing",
        intro: "This is the start of your direct messages with {name}. You both work on",
        introSeparator: ", ",
        introEnd: ".",
        placeholder: "Message {name}…",
        header: {
          deferredTooltip: "Coming later (out of scope for this milestone)",
          localTime: "Local time {time}",
          sharedPackages: "Shared packages · {count}",
          sharedPackagesAriaLabel: "Shared packages",
          presence: {
            online: "Online",
            away: "Away",
            offline: "Offline",
            busy: "Busy"
          }
        }
      },
      thread: {
        title: "Thread",
        closeAriaLabel: "Close the thread",
        loading: "Loading thread…",
        notFound: "This thread does not exist in this channel.",
        replyError: "The reply could not be posted.",
        replyPlaceholder: "Reply to the thread…",
        replyAriaLabel: "Thread reply",
        sendAriaLabel: "Send the reply"
      }
    },
    settings: {
      loading: "Loading settings",
      error: "Settings are unavailable.",
      retry: "Retry",
      nav: {
        title: "Settings",
        navAriaLabel: "Settings sections",
        account: "Account",
        preferences: "Preferences",
        profile: "Profile",
        accountSecurity: "Account & security",
        keys: "SSH / GPG Keys",
        tokens: "Personal access tokens",
        appearance: "Appearance",
        notifications: "Notifications",
        shortcuts: "Keyboard shortcuts",
        codeReadme: "Code README",
        admin: "Admin",
        deferredTooltip: "Coming later (out of scope for this milestone)"
      },
      ssh: {
        title: "SSH Keys",
        pageTitle: "SSH / GPG Keys",
        pageDesc: "SSH keys authorize pushes to Mega2",
        sectionLabel: "Authentication keys",
        add: "Add SSH key",
        emptyTitle: "No SSH keys yet",
        emptyDesc: "Add an SSH key to push code to Mega2",
        emptyHint: "ssh-keygen -t ed25519 -C \"you@example.com\"",
        loadError: "Could not load keys, please try again",
        retry: "Retry",
        addedOn: "Added {date}",
        addModalTitle: "Add SSH key",
        titleField: "Title",
        titlePlaceholder: "For example, MacBook Pro (work)",
        publicKeyField: "Key",
        publicKeyHint: "Paste the full contents of ~/.ssh/id_ed25519.pub",
        addConfirm: "Add SSH key",
        cancel: "Cancel",
        addSuccess: "SSH key added",
        addError: "Could not add the SSH key",
        deleteModalTitle: "Delete SSH key?",
        deleteWarning: "Devices using \"{title}\" will no longer be able to push to Mega2",
        deleteConfirm: "Delete",
        deleteSuccess: "SSH key deleted",
        deleteError: "Could not delete the SSH key",
        gpgSection: "GPG Keys",
        gpgDesc: "GPG keys verify commit signatures",
        gpgPublicKeyHint: "Paste an ASCII-armored GPG public key and never paste a private key",
        gpgEmpty: "No GPG keys yet",
        gpgError: "Could not update the GPG key",
        gpgDeleteTitle: "Delete GPG key?",
        gpgPhase2: "Phase 2",
        gpgAdd: "Add GPG key",
      },
      tokens: {
        title: "Personal access tokens",
        pageTitle: "Personal access tokens",
        pageDesc: "Use tokens in scripts, CI, or CLI tools to access the Mega API as you.",
        securityHint: "Tokens are as sensitive as passwords. Never commit them to a repo or share them.",
        sectionLabel: "Tokens",
        generate: "Generate new token",
        emptyTitle: "No tokens yet",
        emptyDesc: "Generate a token for scripts or automation that need API access.",
        loadError: "Failed to load tokens. Try again.",
        retry: "Retry",
        maskedToken: "Token",
        created: "Created",
        generateSuccess: "Token generated.",
        generateError: "Could not generate a token.",
        revealTitle: "Token generated",
        revealHint: "Copy it now — you will not be able to see the full token again after closing.",
        revealConfirm: "Done",
        revealCloseConfirm: "Close without copying the token?",
        copy: "Copy",
        copyError: "Could not copy to the clipboard.",
        copied: "Copied to clipboard.",
        cancel: "Cancel",
        deleteModalTitle: "Delete token?",
        deleteWarning: "Applications using this token will lose access immediately.",
        deleteConfirm: "Delete",
        deleteSuccess: "Token deleted.",
        deleteError: "Could not delete the token.",
      },
      accountSecurity: {
        pageTitle: "Account & security",
        pageDesc: "Manage how you sign in and the lifecycle of your account.",
        sessionHint: "Browser sign-in is for the Mega Workspace UI and is separate from Git credentials. Push and pull need an",
        sshLink: "SSH key",
        tokensLink: "personal access token",
        email: "Sign-in email",
        createdAt: "Account created",
        passwordSection: "Password",
        passwordTitle: "Password is managed by Better Auth",
        passwordDesc: "Changing your password opens a dedicated verification flow.",
        passwordAction: "Change password ↗",
        changePasswordTitle: "Change password",
        changePasswordDesc: "Choose a new password. Other active sessions will be signed out.",
        currentPassword: "Current password",
        newPassword: "New password",
        confirmPassword: "Confirm new password",
        changePasswordSubmit: "Change password",
        changePasswordSuccess: "Password changed. Other sessions were signed out.",
        changePasswordError: "Could not change your password.",
        passwordMismatch: "The new passwords do not match.",
        passwordTooShort: "Use at least 8 characters for your new password.",
        sessionSection: "Sessions",
        sessionTitle: "Sign out other sessions",
        sessionDesc: "Revoke every session except this browser.",
        sessionSummary: "Active sessions: {count}.",
        sessionAction: "Sign out others",
        revokeOtherSuccess: "Other sessions were signed out.",
        revokeOtherError: "Could not revoke other sessions.",
        dangerSection: "Danger zone",
        deactivateTitle: "Deactivate account",
        deactivateDesc: "Temporarily hide your profile. You could sign in again to restore it.",
        deactivateAction: "Deactivate",
        deactivateUnavailable: "Not available yet — Better Auth has no self-serve deactivate API.",
        deleteTitle: "Delete account",
        deleteDesc: "Permanently delete your account and personal data. Commit and CL history remain, attributed to a deleted user.",
        deleteAction: "Delete account",
        deleteModalTitle: "Delete account?",
        deleteModalSub: "This cannot be undone.",
        deleteWarning: "Commit and CL history are kept, but authorship shows as a deleted user. SSH keys and access tokens are revoked immediately.",
        deleteConfirmHint: "Type your username {username} to confirm",
        deleteConfirm: "Delete permanently",
        deleteSuccess: "Account deleted.",
        deleteError: "Could not delete the account.",
        usernameRequired: "Enter your username exactly to confirm.",
        cancel: "Cancel",
        loadError: "Could not load account security settings.",
        retry: "Retry",
      },
      profile: {
        title: "Profile",
        subtitle: "How you appear across the workspace.",
        avatarChange: "Change avatar",
        avatarModalTitle: "Change avatar",
        avatarUploadCta: "Click to upload an image",
        avatarFileHelp: "PNG, JPG, GIF or WebP, up to 1MB.",
        avatarUrlLabel: "Paste image URL",
        avatarUrlPlaceholder: "https://…",
        avatarRemove: "Remove current avatar",
        avatarCancel: "Cancel",
        avatarSave: "Save avatar",
        avatarSaving: "Saving…",
        avatarTooLarge: "Choose an image smaller than 1MB.",
        avatarTypeInvalid: "Choose an image file.",
        avatarSaveSuccess: "Avatar updated.",
        avatarSaveError: "Could not update the avatar.",
        displayName: "Display name",
        displayNameRequired: "Enter a display name (at most 60 characters).",
        username: "Username",
        usernameHint: "Set at registration and cannot be changed.",
        usernameInvalid: "Usernames use lowercase letters, digits and hyphens (2–31 characters, starting with a letter or digit).",
        email: "Email",
        emailHint: "Managed under Account & security.",
        bio: "Bio",
        bioTooLong: "Bio must be at most 280 characters.",
        cancel: "Cancel",
        save: "Save changes",
        saving: "Saving…",
        saveSuccess: "Profile updated.",
        saveError: "Could not save the profile."
      },
      codeReadmePage: {
        pageTitle: "Code README",
        pageDesc: "The Markdown shown below the file list on the Code page. Only mega2 admins can change it; it is stored in megaui, not in the repository.",
        loading: "Loading the Code README",
        loadError: "Failed to load the Code README. Try again.",
        retry: "Retry",
        editorLabel: "README (Markdown)",
        editorPlaceholder: "# Welcome\n\nDescribe this monorepo…",
        previewTitle: "Saved preview",
        previewEmpty: "Nothing to preview. An empty README hides the section on the Code page.",
        lengthHint: "{count} / {max} characters",
        tooLong: "The README is longer than {max} characters.",
        lastUpdated: "Last updated {time}",
        save: "Save README",
        saving: "Saving…",
        saveSuccess: "Code README saved.",
        saveError: "Could not save the Code README.",
        forbidden: "Only mega2 admins can change the Code README."
      },
      notificationsPage: {
        pageTitle: "Notifications",
        pageDesc: "Manage how workspace events reach you. These settings are backed by mega2 and apply across Change Lists, Issues and references.",
        loading: "Loading notification settings",
        loadError: "Failed to load notification settings. Try again.",
        retry: "Retry",
        globalSection: "Global",
        globalTitle: "Enable notifications",
        globalDesc: "Turn off all workspace notification delivery for this account.",
        globalToggleAriaLabel: "Toggle all notifications",
        deliverySection: "Delivery",
        deliveryMode: "Delivery mode",
        deliveryHint: "Mega2 currently accepts in-app or email delivery.",
        preferredLocale: "Preferred locale",
        localeHint: "Used for notification copy when the backend localizes it.",
        preferencesSection: "Event preferences",
        preferenceToggleAriaLabel: "Toggle {setting}",
        systemRequired: "Required",
        systemRequiredHint: "This event is required by the system and cannot be disabled.",
        save: "Save delivery settings",
        saving: "Saving…",
        saveSuccess: "Notification settings saved.",
        saveError: "Could not save notification settings.",
        toggleError: "Could not update notification setting.",
        unsupportedDeliveryMode: "not editable",
        profileCardTitle: "Notification settings moved",
        profileCardDesc: "Choose delivery mode, locale and event-level preferences from the dedicated Notifications page.",
        profileCardAction: "Open notifications",
        deliveryModeLabels: {
          in_app: "In-app",
          email: "Email",
          realtime: "Realtime"
        },
        localeLabels: {
          "zh-CN": "Chinese (Simplified)",
          en: "English"
        },
        categoryLabels: {
          cl: "Change Lists",
          issue: "Issues",
          reference: "References",
        },
        eventLabels: {
          "cl.comment.created": "New CL comment",
          "cl.merged": "CL merged",
          "issue.comment.created": "New issue comment",
          "issue.closed": "Issue closed",
          "item.referenced": "Item referenced"
        }
      },
      shortcutsPage: {
        pageTitle: "Keyboard shortcuts",
        pageDesc: "Read-only shortcut reference. Custom key bindings are not available in this phase.",
        macColumn: "Mac",
        windowsColumn: "Windows / Linux",
        then: "then",
        groups: {
          navigation: "Navigation",
          code: "Code view",
          cl: "Change List",
          issue: "Issue",
        },
        actions: {
          commandPalette: "Command palette",
          goCode: "Go to Code",
          goIssues: "Go to Issues",
          goCls: "Go to Change Lists",
          goInbox: "Go to Inbox",
          searchFilename: "Search by file name",
          findInFile: "Find in file",
          toggleBlame: "Toggle blame",
          copyPermalink: "Copy permalink",
          submitComment: "Submit comment",
          expandDiffs: "Expand / collapse all diffs",
          nextPrevFile: "Next / previous file",
          markViewed: "Mark as viewed",
          newIssue: "New issue",
          toggleIssueState: "Close / reopen issue",
        },
      },
      appearance: {
        title: "Appearance",
        theme: "Theme",
        modeAriaLabel: "Theme mode",
        modeLight: "Light",
        modeDark: "Dark",
        modeSystem: "Follow system",
        accent: "Accent color",
        accentSwatchAriaLabel: "Use accent color {color}",
        density: "Density",
        densityComfortable: "Comfortable",
        densityCompact: "Compact"
      }
    },
    inbox: {
      loading: "Loading notifications",
      error: "Notifications are unavailable.",
      retry: "Retry",
      rail: {
        title: "Inbox",
        filters: "Notification filters",
        all: "All",
        mentions: "@Me",
        replies: "Replies",
        dm: "Direct messages",
        invite: "Invites",
        saved: "Saved",
        markAllRead: "Mark all as read",
        markAllReadError: "Could not mark notifications as read.",
        settings: "Notification settings",
        deferredTooltip: "Coming later (out of scope for this milestone)"
      },
      list: {
        listAriaLabel: "Notifications",
        unreadSummary: "{count} unread",
        sortUnreadFirst: "Unread first",
        sortLatest: "Latest",
        empty: "Inbox zero!",
        emptyHint: "Nothing needs your attention here — new mentions, replies, DMs, and invites will land in this list."
      },
      pane: {
        emptySelection: "Select a notification to read it.",
        loading: "Loading…",
        save: "Save",
        saved: "Saved",
        markRead: "Mark as read",
        markedRead: "Read",
        contextTitle: "Related context",
        reviewStart: "Start review",
        reviewViewDiff: "View diff",
        reviewLater: "Later",
        kindTitles: {
          mention: "Mention",
          reply: "Reply",
          dm: "Direct message",
          invite: "Channel invite",
          review: "Review request",
          ci: "CI passed",
          cifail: "CI failed",
          issue: "Issue update"
        },
        fanoutTitles: {
          mention: "{actor} mentioned you in {channel}",
          reply: "{actor} replied in {channel}",
          dm: "{actor} sent you a direct message",
          invite: "{actor} invited you to {channel}"
        },
        open: {
          mention: "Open conversation",
          reply: "Open conversation",
          dm: "Open direct message",
          invite: "Open channel",
          review: "Open change list",
          ci: "Open checks",
          cifail: "Open checks",
          issue: "Open issue"
        },
        states: {
          wip: "WIP",
          ready: "ready",
          queued: "queued",
          conflicts: "conflicts",
          merged: "merged",
          closed: "closed"
        },
        quickReply: {
          placeholder: "Quick reply…",
          sendAriaLabel: "Send the quick reply",
          sent: "Reply posted",
          failed: "Could not send the reply."
        }
      }
    },
    docs: {
      loading: "Loading documents",
      error: "Documents are unavailable.",
      retry: "Retry",
      empty: "No documents match this filter.",
      apiErrors: {
        TITLE_CONFLICT: "A document with this title already exists.",
        MEGA_CONFLICT: "This document was updated elsewhere. Refresh and try again.",
        MEGA_NOT_FOUND: "Document not found.",
        MEGA_BAD_REQUEST: "Invalid document request."
      },
      sidebar: {
        title: "Mega Docs",
        newDoc: "New doc",
        allDocs: "All Docs",
        graph: "Link graph",
        tasks: "Tasks",
        calendar: "Calendar",
        imagine: "Imagine",
        shared: "Shared with Me",
        starred: "Starred",
        starredEmpty: "Pin your most-read documents — click ★ to star.",
        folders: "Folders",
        unsorted: "Unsorted",
        tags: "Tags",
        deferredTooltip: "Coming later (out of scope for this milestone)"
      },
      graph: {
        title: "Link graph",
        loading: "Loading link graph…",
        error: "Link graph is unavailable.",
        retry: "Retry",
        empty: "No links yet. Add [[wikilinks]] or embeds in docs to populate the graph.",
        graphAriaLabel: "Workspace link graph",
        legendWikilink: "Wikilink",
        legendEmbed: "Embed",
        legendDoc: "Doc",
        legendIssue: "Issue",
        legendCl: "CL",
        issueAriaLabel: "Issue #{number}",
        clAriaLabel: "CL !{number}"
      },
      header: {
        allTitle: "All Docs",
        stats: "{count} docs · {folders} folders · {authors} authors",
        searchAriaLabel: "Search documents",
        searchPlaceholder: "Search docs, tags, @people",
        viewAriaLabel: "View mode",
        viewGrid: "Grid",
        viewWall: "Wall",
        viewList: "List",
        sortUpdated: "By updated ↓",
        sortTitle: "By title A–Z",
        newDoc: "New doc",
        deferredTooltip: "Coming later (out of scope for this milestone)"
      },
      newDialog: {
        title: "New document",
        titleLabel: "Title",
        titlePlaceholder: "What is this document about?",
        folderLabel: "Folder",
        tagsLabel: "Tags",
        cancel: "Cancel",
        submit: "Create & edit",
        submitting: "Creating…"
      },
      card: {
        starAriaLabel: "Star {title}",
        unstarAriaLabel: "Unstar {title}",
        commentsAriaLabel: "{count} comments"
      }
    },
    docDetail: {
      publication: {
        publish: "Publish",
        publishing: "Publishing…",
        unpublish: "Return to draft",
        unpublishing: "Returning to draft…",
        published: "Document published.",
        unpublished: "Document returned to draft.",
        publishFailed: "Could not publish the document. Please try again.",
        unpublishFailed: "Could not return the document to draft. Please try again."
      },
      loading: "Loading document",
      error: "The document is unavailable.",
      retry: "Retry",
      notFoundTitle: "Document not found",
      notFoundBody: "This document does not exist.",
      backToDocs: "Back to docs",
      snapshotBanner: "Viewing version snapshot v{version} (read-only).",
      backToLatest: "Back to latest",
      restoreVersion: "Restore this version",
      restoringVersion: "Restoring…",
      restoreSuccess: "Version restored.",
      restoreFailed: "Restore failed.",
      metaEditor: {
        tagToggleAriaLabel: "Toggle tag {tag}",
        statusLabel: "Status",
        statusPublished: "Published",
        statusDraft: "Draft",
        starAriaLabel: "Star {title}",
        unstarAriaLabel: "Unstar {title}"
      },
      versions: {
        title: "Versions",
        versionLine: "{version} · {time} · {summary}",
        versionAriaLabel: "View version {version} snapshot"
      },
      toc: {
        title: "Contents",
        readingTime: "~{minutes} min read",
        versions: "{count} versions"
      },
      toolbar: {
        breadcrumbDocs: "Docs",
        share: "Share",
        copied: "Link copied",
        history: "History",
        exportDoc: "Export",
        edit: "Edit",
        rename: "Rename",
        renameSave: "Save",
        renameCancel: "Cancel",
        renameAriaLabel: "Document title",
        deferredTooltip: "Coming later (out of scope for this milestone)",
        presenceAriaLabel: "Editors online",
        shareDialog: {
          title: "Share document",
          close: "Close",
          copyLink: "Copy link",
          copied: "Link copied",
          defaultOpenNote: "Access is fail-closed: only users with permission can open this document.",
          collaboratorsHeading: "Collaborators",
          collaboratorsEmpty: "No explicit collaborators listed.",
          copyFailed: "Could not copy link.",
          roleOwner: "Owner",
          roleEditor: "Editor",
          roleViewer: "Viewer"
        }
      },
      article: {
        createdAt: "created {time}",
        updatedAt: "edited {time}",
        viewsAriaLabel: "{count} views",
        commentsAriaLabel: "{count} comments",
        statusPublished: "Published",
        statusDraft: "Draft",
        emptyBody: "This page is empty.",
        openEditor: "Start writing in the editor",
        createRefPage: "Create \"{title}\"",
        blockRefs: {
          copyRef: "Copy reference",
          unresolved: "Unresolved block",
          forbidden: "No access"
        },
        embeds: {
          cycle: "Circular embed",
          tooDeep: "Embed nesting exceeds depth limit",
          unresolved: "Unresolved embed",
          noAccess: "No access",
          loading: "Loading embed…",
          openSource: "Open source"
        },
        zoom: {
          breadcrumbAriaLabel: "Zoom breadcrumb",
          pageCrumb: "Full page",
          backToFullPage: "Back to full page",
          zoom: "Zoom in",
          collapse: "Collapse",
          expand: "Expand",
          copyBlockRef: "Copy block reference",
          menuAriaLabel: "Block actions",
          copyDeepLink: "Copy block link",
          deleteBlock: "Delete block",
          deleteConfirm: "Delete this block?",
          deleteConfirmAction: "Delete",
          deleteCancel: "Cancel",
          copySubtree: "Copy block",
          cutBlock: "Cut block",
          insertBelow: "Insert below",
          insertAbove: "Insert above",
          turnInto: "Turn into…",
          turnH1: "Heading 1",
          turnH2: "Heading 2",
          turnH3: "Heading 3",
          turnText: "Paragraph",
          turnQuote: "Quote",
          turnTodo: "Checklist",
          turnCode: "Code block",
          openInSidePanel: "Open in side panel",
          othersEditing: "Others editing: {names}",
          sidePanelAriaLabel: "Block side panel",
          sidePanelClose: "Close panel",
          sidePanelInvalid: "This block is missing or unavailable."
        }
      },
      meta: {
        collaborators: "Collaborators",
        roleAuthor: "author",
        roleEditor: "editor",
        tags: "Tags",
        linked: "Linked",
        recentVersions: "Recent versions",
        versionLine: "{version} · {time} · {summary}",
        none: "None",
        backlinks: {
          title: "Backlinks",
          empty: "No pages link here yet.",
          unlinkedTitle: "Unlinked mentions",
          unlinkedEmpty: "No unlinked mentions.",
          convertLink: "Convert to link",
          converting: "Converting…",
          typeDoc: "Doc",
          typeIssue: "Issue",
          typeCl: "CL",
          typeOther: "Ref",
          blockContext: "Referenced block: {summary}"
        }
      },
      comments: {
        title: "Comments ({count})",
        empty: "No comments yet. Start the discussion.",
        addReaction: "Add reaction",
        authorRole: "author",
        typingAriaLabel: "{name} is typing",
        commentAdded: "Comment added.",
        actionFailed: "Action failed.",
        composer: {
          close: "Close",
          closing: "Closing…",
          placeholder: "Leave a comment…",
          preview: "Preview",
          previewEmpty: "Nothing to preview",
          submit: "Comment",
          submitting: "Commenting…",
          write: "Write",
          cmdEnterHint: "⌘Enter to comment"
        }
      }
    },
    docEdit: {
      loading: "Loading document",
      error: "The document is unavailable.",
      retry: "Retry",
      notFoundTitle: "Document not found",
      backToDocs: "Back to docs",
      backToDoc: "Back to document",
      placeholder: "Start writing — Markdown shortcuts work (#, >, -, - [ ], ```)…",
      saveVersion: "Save version",
      saveVersionSubmit: "Save",
      versionSummaryAriaLabel: "Version summary",
      versionSummaryPlaceholder: "What changed? (required)",
      mentionAriaLabel: "Mention suggestions",
      wikilinks: {
        ariaLabel: "Link suggestions",
        createPage: "Create \"{title}\"",
        empty: "No matching pages"
      },
      quickCommands: {
        ariaLabel: "Quick commands",
        todo: "TODO",
        table: "Table",
        image: "Image",
        pageReference: "Page reference",
        blockReference: "Block reference",
        tagPage: "Tag page"
      },
      todoCheckbox: {
        markComplete: "Mark TODO complete",
        markIncomplete: "Mark TODO incomplete"
      },
      blockCollapse: {
        collapse: "Collapse block",
        expand: "Expand block"
      },
      blockContextMenu: {
        ariaLabel: "Block actions",
        copyBlockRef: "Copy block ref",
        copyBlockId: "Copy block ID",
        copyBlockLink: "Copy block link",
        copyEmbed: "Copy embed",
        focusBlock: "Focus on block",
        openInSidebar: "Open in sidebar",
        expandAll: "Expand all",
        collapseAll: "Collapse all",
        makeTodo: "Make TODO",
        removeTodo: "Remove TODO",
        textStyle: "Text style",
        heading1: "Heading 1",
        heading2: "Heading 2",
        heading3: "Heading 3"
      },
      sidePanel: {
        resize: "Resize block sidebar",
        ariaLabel: "Block sidebar",
        breadcrumbAriaLabel: "Block path",
        close: "Close",
        invalid: "This block is no longer available",
        referenceCount: "{count} references"
      },
      images: {
        dialog: "Insert image",
        url: "Image URL",
        alt: "Description",
        file: "Or upload a file",
        insert: "Insert",
        cancel: "Cancel",
        invalid: "Choose a PNG, JPEG, GIF, WebP, or BMP image, or enter a valid HTTP(S) URL.",
        uploading: "Uploading image…"
      },
      tableControls: {
        addRow: "+ row",
        addColumn: "+ column",
        deleteRow: "Delete row",
        deleteColumn: "Delete column",
        deleteTable: "Delete table"
      },
      blockRefs: {
        ariaLabel: "Block reference suggestions",
        empty: "No matching blocks",
        copyRef: "Copy reference",
        unresolved: "Unresolved block",
        forbidden: "No access"
      },
      embeds: {
        ariaLabel: "Embed suggestions",
        empty: "No matching pages or blocks",
        pagesGroup: "Pages",
        blocksGroup: "Blocks",
        cycle: "Circular embed",
        tooDeep: "Embed nesting exceeds depth limit",
        unresolved: "Unresolved embed",
        noAccess: "No access",
        loading: "Loading embed…",
        openSource: "Open source"
      },
      slashMenu: {
        ariaLabel: "Insert block",
        heading1: "Heading 1",
        heading2: "Heading 2",
        heading3: "Heading 3",
        unorderedList: "Bulleted list",
        orderedList: "Numbered list",
        checklist: "Checklist",
        quote: "Quote",
        code: "Code block",
        table: "Table",
        divider: "Divider"
      },
      floatingToolbar: {
        ariaLabel: "Text formatting",
        bold: "Bold",
        italic: "Italic",
        strikethrough: "Strikethrough",
        code: "Inline code",
        link: "Link",
        linkPlaceholder: "https://…"
      },
      codeLanguageAriaLabel: "Code block language",
      autoSaveHint: "Auto-saves 2s after typing",
      saving: "Saving…",
      saved: "Saved",
      collabConnecting: "Connecting…",
      collabConnected: "Live",
      collabOffline: "Offline — edits kept locally",
      collabLive: "Live collaboration",
      collabReadonly: "Collaboration unavailable — read only",
      presenceAriaLabel: "Editors online",
      zoom: {
        breadcrumbAriaLabel: "Zoom breadcrumb",
        pageCrumb: "Full page",
        backToFullPage: "Back to full page",
        zoom: "Zoom in",
        collapse: "Collapse",
        expand: "Expand",
        copyBlockRef: "Copy block reference",
        menuAriaLabel: "Block actions",
        copyDeepLink: "Copy block link",
        deleteBlock: "Delete block",
        deleteConfirm: "Delete this block?",
        deleteConfirmAction: "Delete",
        deleteCancel: "Cancel",
        copySubtree: "Copy block",
        cutBlock: "Cut block",
        insertBelow: "Insert below",
        insertAbove: "Insert above",
        turnInto: "Turn into…",
        turnH1: "Heading 1",
        turnH2: "Heading 2",
        turnH3: "Heading 3",
        turnText: "Paragraph",
        turnQuote: "Quote",
        turnTodo: "Checklist",
        turnCode: "Code block",
        openInSidePanel: "Open in side panel",
        othersEditing: "Others editing: {names}",
        sidePanelAriaLabel: "Block side panel",
        sidePanelClose: "Close panel",
        sidePanelInvalid: "This block is missing or unavailable."
      }
    },
    clsList: {
      title: "Change Lists",
      replacesPr: "CLs replace Pull Requests",
      newCl: "New CL",
      filterAriaLabel: "Filter change lists",
      filterPlaceholder: "is:open reviewer:@me pkg:*",
      loading: "Loading change lists",
      error: "Change Lists are unavailable.",
      retry: "Retry",
      empty: "No change lists match this filter.",

      pageSize: 20,
      pagination: {
        previous: "Previous",
        next: "Next",
        pageStatus: "Page {page} of {total}"
      },      row: {
        atomic: "ATOMIC",
        pkgs: "{count} pkgs",
        byRev: "by {author} · rev {rev}",
        files: "{count}f",
        approvedSummary: "{approved}/{total}",
        reviewersAriaLabel: "Reviewers",
        states: {
          wip: "WIP",
          ready: "ready",
          queued: "queued",
          conflicts: "conflicts",
          merged: "merged",
          closed: "closed"
        },
        ci: {
          passing: "passing",
          failing: "failing",
          queued: "queued"
        },
        verdicts: {
          approved: "approved",
          commented: "commented",
          requested: "requested",
          pending: "pending"
        }
      },
      dropdowns: {
        author: "Author",
        reviewer: "Reviewer",
        package: "Package",
        state: "State",
        sort: "Sort",
        all: "All",
        me: "@me",
        states: {
          wip: "WIP",
          ready: "ready",
          queued: "queued",
          conflicts: "conflicts",
          merged: "merged",
          closed: "closed"
        },
        sorts: {
          "updated-desc": "Recently updated",
          "updated-asc": "Least recently updated",
          "created-desc": "Newest",
          "created-asc": "Oldest",
          "priority-desc": "Priority"
        }
      },
      newDialog: {
        title: "New Change List",
        titleLabel: "Title",
        titlePlaceholder: "What does this CL change?",
        packageLabel: "Package",
        branchLabel: "Branch",
        branchPlaceholder: "feat/…",
        cancel: "Cancel",
        submit: "Create CL",
        submitting: "Creating…",
        pushHint: "One push can carry multiple commits — they all belong to the same CL."
      }
    },
    clDetail: {
      notFoundTitle: "Change List not found",
      notFoundBody: "CL !{number} does not exist.",
      backToList: "Back to Change Lists",
      loading: "Loading change list",
      error: "The change list is unavailable.",
      retry: "Retry",
      chrome: {
        breadcrumbCls: "Change Lists",
        states: {
          wip: "WIP",
          ready: "ready",
          queued: "queued",
          conflicts: "conflicts",
          merged: "merged",
          closed: "closed"
        },
        mergeSubject: "{author} wants to merge {branch} into {target}",
        revMeta: "rev {rev} of {total}",
        filesSummary: "{count} files",
        rebase: "Rebase",
        merge: "Merge",
        tabs: {
          conversation: "Conversation",
          revisions: "Revisions",
          files: "Files changed",
          checks: "Checks",
          deps: "Dependencies"
        }
      },
      revisions: {
        loading: "Loading revisions",
        error: "Revisions are unavailable.",
        retry: "Retry",
        empty: "This CL has no revisions yet.",
        timelineAriaLabel: "Revision timeline",
        baseMarkerAriaLabel: "Branch base",
        baseMarker: "{base} — original branch point",
        compareBar: {
          compare: "Compare",
          fromAriaLabel: "Compare from revision",
          toAriaLabel: "Compare to revision",
          revChip: "rev {rev}",
          filesAcross: "{files} files across {revisions} revisions",
          viewRangeDiff: "View range diff"
        },
        card: {
          title: "Revision {rev}",
          current: "CURRENT",
          forcePush: "FORCE-PUSH",
          commits: "{count} commits",
          rebase: "rebase",
          upstreamCommits: "+ {count} upstream commits",
          base: "base {base}",
          ci: "CI {status}",
          ciStatuses: {
            passing: "passing",
            failing: "failing",
            queued: "queued",
            running: "running",
            skipped: "skipped"
          },
          reviewed: "reviewed:",
          diffAgainst: "Diff against rev {rev}"
        },
        clCommits: {
          title: "Commit chain",
          commits: "{count} commits",
          loading: "Loading commit chain",
          error: "The commit chain is unavailable.",
          retry: "Retry",
          empty: "This CL has no commits yet."
        },
        rangeSummary: {
          rangeTitle: "Range diff summary",
          fetchTitle: "How to fetch",
          subscribeTitle: "Subscribe",
          subscribeAriaLabel: "Subscribe to new revisions",
          subscribeText: "Notify {me}, reviewers, and the owner team when a new revision is pushed."
        }
      },
      files: {
        loading: "Loading changed files",
        error: "Changed files are unavailable.",
        retry: "Retry",
        empty: "This CL has no changed files.",
        invalidRange: "Unknown revision range \"{range}\" — showing the full diff.",
        list: {
          filterAriaLabel: "Filter changed files",
          filterPlaceholder: "Filter files…",
          treeAriaLabel: "Changed files",
          viewedProgress: "{viewed}/{total} viewed",
          files: "files",
          added: "added",
          modified: "modified",
          deleted: "deleted"
        },
        toolbar: {
          styleAriaLabel: "Diff style",
          unified: "Unified",
          split: "Split",
          viewed: "Viewed",
          rangeBadge: "rev {range}"
        }
      },
      inlineThreads: {
        addAriaLabel: "Add a review comment on this line",
        thread: {
          resolved: "RESOLVED",
          reply: "Reply",
          quote: "Quote",
          resolve: "Resolve",
          unresolve: "Unresolve",
          replyAriaLabel: "Reply to this review thread",
          cancelReplyAriaLabel: "Cancel the reply",
          replyPlaceholder: "Reply…",
          replySubmit: "Reply",
          revStamp: "rev {rev}",
          quoteAttribution: "Quoted from {author}"
        },
        draft: {
          inputAriaLabel: "New review thread on this line",
          placeholder: "Start a review thread on this line…",
          submit: "Comment",
          cancel: "Cancel"
        }
      },
      checks: {
        loading: "Loading checks",
        error: "Checks are unavailable.",
        retry: "Retry",
        hero: {
          allPassed: "All checks passed",
          inProgress: "Checks in progress",
          someFailed: "Some checks failed",
          summary: "{ok} of {total} checks succeeded · {skipped} skipped · pipeline duration {duration}",
          kvPipeline: "Pipeline",
          kvTrigger: "Trigger",
          kvRunner: "Runner",
          kvQueued: "Queued",
          trigger: "push · rev {rev}",
          rerun: "Re-run all"
        },
        stageFlow: {
          title: "Pipeline",
          jobs: "{ok}/{total} jobs",
          skipped: "skipped"
        },
        table: {
          check: "Check",
          matrix: "Matrix",
          duration: "Duration",
          logs: "Logs",
          passPill: "{count} pass",
          statusAriaLabel: "Status: {status}"
        },
        benchPill: "{from} → {to} ({delta})",
        tail: "Tail",
        downloadAriaLabel: "Download the log tail",
        consoleAriaLabel: "Log tail for {check}",
        bench: {
          title: "Benchmark delta",
          from: "from {value}"
        }
      },
      deps: {
        loading: "Loading dependencies",
        error: "Dependencies are unavailable.",
        retry: "Retry",
        graph: {
          title: "Package dependency graph",
          compileTime: "compile-time",
          graphAriaLabel: "Package dependency graph",
          legendUpstream: "upstream",
          legendThis: "this",
          legendDownstream: "downstream",
          columnUpstream: "UPSTREAM (built before)",
          columnThis: "THIS CL",
          columnDownstream: "DOWNSTREAM (rebuilt)",
          rebuilt: "{count} packages rebuilt on merge",
          hotConsumer: "{count} hot consumer ({name})",
          ciTime: "est. CI time {duration}"
        },
        api: {
          title: "Public API changes",
          nonBreaking: "NON-BREAKING",
          tool: "cargo public-api"
        },
        related: {
          title: "Related CLs",
          relations: {
            blocks: "blocks",
            "depends-on": "depends on",
            supersedes: "supersedes",
            follows: "follows"
          }
        },
        issues: {
          title: "Linked issues",
          closes: "CLOSES",
          none: "None"
        },
        symbols: {
          title: "Reverse symbol usage",
          refs: "{refs} refs · {files}f",
          updated: "Codex index · updated {time}"
        }
      },
      conversation: {
        loading: "Loading conversation",
        error: "The conversation is unavailable.",
        retry: "Retry",
        viewed: "Viewed",
        description: {
          badge: "DESCRIPTION",
          openedMeta: "opened this CL · {time}",
          closes: "Closes:",
          empty: "No description provided.",
          edit: "Edit",
          finishEditing: "Done",
          saving: "Saving…",
          saved: "Saved",
          autoSaveHint: "Autosaves after 2 seconds",
          placeholder: "Describe this change list…",
          saveFailed: "Save failed — retry"
        },
        thread: {
          commentedOn: "commented on {file} {line} · {time}",
          resolved: "RESOLVED"
        },
        inlineSection: {
          title: "Inline comments",
          empty: "No inline comments yet.",
          add: "Add inline comment",
          filePath: "File path",
          line: "Line",
          body: "Comment",
          submit: "Comment on line",
          submitting: "Posting…"
        },
        emptyPatch: "(empty patch)",
        mergeBox: {
          readyTitle: "Ready to merge",
          readySubtitle: "{approvals} approvals · merge score {score} · no conflicts with main",
          needsReviewTitle: "Review required",
          needsReviewSubtitle: "{approvals}/{total} approvals",
          inQueueTitle: "In merge queue",
          inQueueSubtitle: "Position {position}",
          rebaseTitle: "Rebase needed",
          rebaseSubtitle: "This CL conflicts with main.",
          merged: "Merged",
          mergeAction: "Merge CL",
          rebaseAction: "Rebase",
          squashNote: "Merging this CL creates exactly one new commit on main."
        },
        composer: {
          write: "Write",
          preview: "Preview",
          placeholder: "@mention · #issue · !CL · [[page]]…",
          previewEmpty: "Nothing to preview yet.",
          submit: "Comment",
          submitting: "Commenting…",
          close: "Close",
          closing: "Closing…",
          cmdEnterHint: "⌘/Ctrl+Enter to comment"
        },
        sidebar: {
          reviewers: "Reviewers",
          owners: "Owners (auto)",
          package: "Package",
          linkedIssues: "Linked Issues",
          checks: "Checks",
          revisions: "Revisions",
          closesOnMerge: "closes on merge",
          none: "None",
          backlinks: {
            title: "Backlinks",
            empty: "No content links to this CL yet.",
            unlinkedTitle: "Unlinked mentions",
            unlinkedEmpty: "No unlinked mentions.",
            convertLink: "Convert to link",
            converting: "Converting…",
            typeDoc: "Doc",
            typeIssue: "Issue",
            typeCl: "CL",
            typeOther: "Ref",
            blockContext: "Referenced block: {summary}"
          },
          verdicts: {
            approved: "approved",
            commented: "commented",
            requested: "requested",
            pending: "pending"
          }
        }
      }
    },
    issues: {
      title: "Issues",
      scopeAllPackages: "All packages",
      labelsChip: "Labels · {count}",
      milestonesChip: "Milestones · {count}",
      newIssue: "New issue",
      filterAriaLabel: "Filter issues",
      filterPlaceholder: "is:open priority:P0..P2 pkg:git-internal…",
      openTab: "Open",
      closedTab: "Closed",
      loading: "Loading issues",
      error: "Issues are unavailable.",
      retry: "Retry",
      empty: "No issues match this filter.",
      countsError: "Counts are unavailable.",
      row: {
        openedBy: "opened {time} by {author}",
        unassigned: "Unassigned",
        assigneesAriaLabel: "Assignees",
        updated: "updated",
        closed: "closed"
      },
      dropdowns: {
        author: "Author",
        label: "Label",
        package: "Package",
        priority: "Priority",
        assignee: "Assignee",
        sort: "Sort",
        all: "All",
        me: "@me",
        sorts: {
          "updated-desc": "Recently updated",
          "updated-asc": "Least recently updated",
          "created-desc": "Newest",
          "created-asc": "Oldest",
          "priority-desc": "Priority"
        }
      },
      newDialog: {
        title: "New issue",
        titleLabel: "Title",
        titlePlaceholder: "Describe the problem…",
        descriptionLabel: "Description (optional)",
        descriptionPlaceholder: "Add context, expected behavior, or reproduction steps…",
        packageLabel: "Package",
        priorityLabel: "Priority",
        cancel: "Cancel",
        submit: "Create issue",
        submitting: "Creating…"
      },
      detail: {
        notFoundTitle: "Issue not found",
        notFoundBody: "Issue #{number} does not exist.",
        backToList: "Back to Issues",
        body: {
          title: "Description",
          edit: "Edit",
          finishEditing: "Done",
          saving: "Saving…",
          saved: "Saved",
          autoSaveHint: "Autosaves after 2 seconds",
          empty: "No description provided.",
          placeholder: "Describe this issue…",
          saveFailed: "Save failed — retry"
        },
        header: {
          breadcrumbIssues: "Issues",
          openPill: "Open",
          closedPill: "Closed",
          meta: "{author} opened {time} · {comments} comments · pkg{package}",
          watching: "Watching",
          watch: "Watch"
        },
        timeline: {
          addReaction: "Add a reaction",
          authorRole: "Author",
          assigneeRole: "Assignee"
        },
        composer: {
          write: "Write",
          preview: "Preview",
          placeholder: "@mention · #issue · !CL · [[page]]…",
          previewEmpty: "Nothing to preview yet.",
          submit: "Comment",
          submitting: "Commenting…",
          close: "Close issue",
          closing: "Closing…",
          reopen: "Reopen issue",
          reopening: "Reopening…",
          cmdEnterHint: "⌘/Ctrl+Enter to comment"
        },
        toasts: {
          closed: "Issue closed.",
          reopened: "Issue reopened.",
          watchOn: "Watching this issue.",
          watchOff: "Stopped watching this issue.",
          commentAdded: "Comment added.",
          actionFailed: "Action failed."
        },
        sidebar: {
          assignees: "Assignees",
          labels: "Labels",
          package: "Package",
          milestone: "Milestone",
          linkedCls: "Linked Change Lists",
          participants: "Participants",
          progress: "{percent}% done",
          none: "None",
          backlinks: {
            title: "Backlinks",
            empty: "No content links to this issue yet.",
            unlinkedTitle: "Unlinked mentions",
            unlinkedEmpty: "No unlinked mentions.",
            convertLink: "Convert to link",
            converting: "Converting…",
            typeDoc: "Doc",
            typeIssue: "Issue",
            typeCl: "CL",
            typeOther: "Ref",
            blockContext: "Referenced block: {summary}"
          }
        }
      }
    }
  },
  validators: {
    user: {
      name: {
        minLength: "Name needs at least {min} characters",
        maxLength: "Name can't exceed {max} characters"
      },
      email: {
        invalid: "That doesn't look like a valid email address"
      },
      username: {
        invalid: "Username must be 2–31 lowercase letters, numbers, or hyphens"
      },
      image: {
        invalidUrl: "That doesn't look like a valid URL"
      },
      password: {
        minLength: "Password needs at least {min} characters",
        maxLength: "Password can't exceed {max} characters",
        mismatch: "Passwords don't match"
      },
      countryCode: {
        required: "Choose a country or region"
      },
      phoneNumber: {
        required: "Enter a phone number",
        invalid: "That phone number format isn't recognized"
      },
      verificationCode: {
        invalidLength: "The verification code must be exactly {length} characters"
      },
      id: {
        required: "User ID is required"
      },
      currentPassword: {
        required: "Enter your current password"
      },
      confirmPassword: {
        required: "Confirm your password"
      },
      deleteAccount: {
        confirmRequired: "Confirm that you want to delete the account"
      }
    },
    userImage: {
      USER_IMAGE_INVALID_SCHEME: "Profile image must be an HTTP(S) URL, not embedded data",
      USER_IMAGE_INVALID_URL: "Profile image URL is not from an allowed source"
    }
  },
  countries: {
    china: "China",
    usa: "United States",
    uk: "United Kingdom",
    japan: "Japan",
    korea: "South Korea",
    singapore: "Singapore",
    hongkong: "Hong Kong",
    macau: "Macau",
    australia: "Australia",
    france: "France",
    germany: "Germany",
    india: "India",
    malaysia: "Malaysia",
    thailand: "Thailand"
  },
  header: {
    auth: {
      signIn: "Sign In",
      getStarted: "Get Started",
      signOut: "Sign Out"
    },
    userMenu: {
      dashboard: "Dashboard",
      workspace: "Workspace",
      profile: "Profile",
      settings: "Settings",
      personalSettings: "Personal Settings"
    },
    language: {
      switchLanguage: "Switch Language",
      english: "English",
      chinese: "中文"
    },
    mobile: {
      themeSettings: "Theme Settings",
      languageSelection: "Choose language"
    }
  },
  upload: {
    title: "Upload Files",
    description: "Send images to cloud storage",
    providerTitle: "Storage Provider",
    providerDescription: "Select your preferred S3-compatible storage provider",
    providers: {
      s3: "Amazon S3",
      s3Description: "Worldwide object storage",
      r2: "Cloudflare R2",
      r2Description: "Zero egress fees"
    },
    uploadTitle: "Upload Image",
    uploadDescription: "Drop an image here or click to choose one. Limit 1MB.",
    dragDrop: "Drag & drop file here",
    orClick: "or click to choose a file (1MB limit)",
    browseFiles: "Browse files",
    clearAll: "Clear all",
    uploadedTitle: "Uploaded Files",
    uploadedDescription: "{count} file(s) uploaded",
    uploading: "Uploading...",
    viewFile: "View",
    uploaded: "Uploaded",
    errors: {
      maxFiles: "Only one file can be uploaded at a time",
      imageOnly: "Only image files are accepted",
      fileTooLarge: "Files must be smaller than 1MB"
    },
    apiErrors: {
      UPLOAD_NO_FILE: "No file provided",
      UPLOAD_FILE_TOO_LARGE: "File size exceeds the maximum limit of {maxMb}MB",
      UPLOAD_INVALID_TYPE_AVATAR: "Invalid file type. Avatar uploads allow image files only.",
      UPLOAD_INVALID_TYPE_GENERAL: "Invalid file type. Only images are allowed (JPEG, PNG, GIF, WebP, SVG, BMP).",
      UPLOAD_INVALID_EXTENSION: "Invalid file extension",
      UPLOAD_FAILED: "Failed to upload file"
    }
  },
  errors: {
    search: {
      cjkScaleExceeded: "Search is temporarily unavailable for CJK queries because the workspace has grown too large for this search mode. Try an English query, or narrow the search."
    },
    auth: {
      unauthorized: "Authentication required",
    },
    mega: {
      badRequest: "Invalid request.",
      notFound: "Resource not found.",
      forbidden: "You do not have permission to perform this action.",
      conflict: "This resource was updated elsewhere. Refresh and try again.",
      titleConflict: "A document with this title already exists.",
      internal: "Unable to process request.",
    },
  },
  // WA-01 homepage (ADR-ARCH-09) — megaui-only; not ported from upstream SaaS `home`.
  home: {
    login: "Login",
    enterWorkspace: "Enter Workspace",
    metadata: {
      title: "Mega",
      description: "Sign in or enter your Mega workspace.",
    },
  },
} satisfies Locale
