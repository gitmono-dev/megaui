// megaui:libs/i18n/locales/zh-CN.ts@0ff3a9d
//
// Upstream key names kept where retained (see README "Provenance" and
// "Removed namespaces" tables for the full diff). All values below are
// rewritten to brand-neutral copy for Mega — no upstream product name
// appears in any translation value.
import type { Locale } from './types'

export const zhCN = {
  common: {
    welcome: "欢迎使用 Mega",
    siteName: "Mega",
    login: "登录",
    signup: "注册",
    logout: "退出登录",
    profile: "个人资料",
    settings: "设置",
    and: "和",
    loading: "加载中...",
    unexpectedError: "发生了意外错误",
    notAvailable: "不可用",
    yes: "是",
    no: "否",
    theme: {
      light: "浅色主题",
      dark: "深色主题",
      system: "系统主题",
      toggle: "切换主题",
      appearance: "外观设置",
      colorScheme: "配色方案"
    }
  },
  actions: {
    save: "保存",
    cancel: "取消",
    confirm: "确认",
    delete: "删除",
    edit: "编辑",
    tryAgain: "重试",
    createAccount: "创建账户",
    sendCode: "发送验证码",
    verify: "验证",
    saveChanges: "保存更改",
    back: "返回",
    resendCode: "重新发送",
    resendVerificationEmail: "再次发送验证邮件",
    upload: "上传",
    previous: "上一页",
    next: "下一页"
  },
  email: {
    verification: {
      subject: "验证您的 Mega 账号",
      title: "请验证您的邮箱地址",
      greeting: "您好 {{name}}，",
      message: "感谢您创建 Mega 账号。要完成账号设置，请点击下方按钮验证您的电子邮箱地址。",
      button: "验证邮箱地址",
      alternativeText: "也可以把下面的地址粘贴到浏览器中打开：",
      expiry: "链接 {{expiry_hours}} 小时内有效。",
      disclaimer: "如果您没有请求此验证，请忽略此邮件。",
      signature: "Mega 团队",
      copyright: "© {{year}} Mega. 保留所有权利。"
    },
    resetPassword: {
      subject: "重置您的 Mega 密码",
      title: "重置您的密码",
      greeting: "您好 {{name}}，",
      message: "有人申请修改你账户的密码。点击下方按钮即可设置新密码；如果不是你本人操作，请忽略这封邮件。",
      button: "重置密码",
      alternativeText: "也可以把下面的地址粘贴到浏览器中打开：",
      expiry: "链接 {{expiry_hours}} 小时内有效。",
      disclaimer: "如果你没有申请重置密码，不需要做任何事。",
      signature: "Mega 团队",
      copyright: "© {{year}} Mega. 保留所有权利。"
    }
  },
  auth: {
    metadata: {
      signin: {
        title: "Mega - 登录",
        description: "登录您的 Mega 账户，访问您的工作台。",
        keywords: "登录, 账户登录, 身份验证, 访问账户, 工作台"
      },
      signup: {
        title: "Mega - 创建账户",
        description: "创建您的 Mega 账户，开始在工作台中协作。",
        keywords: "注册, 新账户, 加入, 开始使用, 账户开通"
      },
      forgotPassword: {
        title: "Mega - 重置密码",
        description: "安全地重置您的 Mega 账户密码。输入您的邮箱以接收密码重置说明。",
        keywords: "忘记密码, 重置密码, 密码恢复, 账户恢复"
      },
      resetPassword: {
        title: "Mega - 创建新密码",
        description: "为您的 Mega 账户创建新的安全密码。选择强密码来保护您的账户。",
        keywords: "新密码, 密码重置, 安全密码, 账户安全"
      }
    },
    signin: {
      title: "登录您的账户",
      welcomeBack: "欢迎回来",
      socialLogin: "使用您喜欢的社交账号登录",
      continueWith: "或继续使用",
      email: "邮箱",
      emailPlaceholder: "请输入邮箱地址",
      password: "密码",
      forgotPassword: "忘记密码？",
      rememberMe: "记住我",
      submit: "登录",
      submitting: "登录中...",
      noAccount: "还没有账户？",
      signupLink: "注册",
      termsNotice: "点击继续即表示您同意我们的",
      termsOfService: "服务条款",
      privacyPolicy: "隐私政策",
      socialProviders: {
        google: "Google",
        github: "GitHub",
        apple: "Apple"
      },
      errors: {
        invalidEmail: "请输入有效的邮箱地址",
        requiredEmail: "请输入邮箱",
        requiredPassword: "请输入密码",
        invalidCredentials: "邮箱或密码错误",
        emailNotVerified: {
          title: "需要邮箱验证",
          description: "确认链接已发送到你的收件箱，请打开链接继续；如果一直没收到，可以在下方重新获取。",
          resendSuccess: "新的确认邮件已发出，请查看收件箱。",
          resendError: "重发验证邮件失败，请稍后重试。",
          dialogTitle: "重新发送验证邮件",
          dialogDescription: "请确认后重新发送验证邮件",
          emailLabel: "邮箱地址",
          sendButton: "发送验证邮件",
          sendingButton: "发送中...",
          waitButton: "等待 {seconds}s"
        }
      },
      feishu: {
        title: "使用飞书登录",
        description: "输入工作邮箱，我们会通过飞书向你发送登录验证码。",
        email: "工作邮箱",
        emailPlaceholder: "name@company.com",
        request: "发送验证码",
        requesting: "发送中…",
        invalidEmail: "请输入有效的邮箱地址。",
        requestFailed: "验证码未能发送，请重试。",
        codeSent: "如果 {email} 属于本组织成员，登录验证码已通过飞书发送。",
        code: "验证码",
        codePlaceholder: "8 位验证码",
        verify: "登录",
        verifying: "登录中…",
        verifyFailed: "登录未完成，请重试。",
        codeInvalid: "验证码无效或已过期。",
        accountConflict: "该邮箱已被本站的其它账号使用，无法通过飞书登录，请联系管理员。",
        codeRetry: "登录未完成，请重新获取验证码。",
        resend: "重新发送",
        resendWait: "{seconds} 秒后可重新发送",
        codeResent: "已重新请求验证码，此前发送的验证码不再有效。",
        changeEmail: "更换邮箱"
      }
    },
    signup: {
      title: "创建您的账户",
      createAccount: "创建账户",
      socialSignup: "使用您喜欢的社交账号注册",
      continueWith: "或继续使用",
      name: "姓名",
      namePlaceholder: "请输入您的姓名",
      email: "邮箱",
      emailPlaceholder: "请输入邮箱地址",
      username: "用户名",
      usernamePlaceholder: "请选择用户名",
      usernameHint: "小写字母、数字和连字符（2–31 个字符）",
      password: "密码",
      passwordPlaceholder: "创建密码",
      imageUrl: "头像图片链接",
      imageUrlPlaceholder: "https://example.com/avatar.png",
      optional: "可选",
      submit: "创建账户",
      submitting: "创建账户中...",
      haveAccount: "已有账户？",
      signinLink: "登录",
      termsNotice: "点击继续即表示您同意我们的",
      termsOfService: "服务条款",
      privacyPolicy: "隐私政策",
      verification: {
        title: "需要验证",
        sent: "我们已经发送验证邮件到",
        checkSpam: "找不到邮件？请检查垃圾邮件文件夹。",
        spamInstruction: "如果仍然没有收到，"
      },
      errors: {
        invalidName: "请输入有效的姓名",
        requiredName: "请输入姓名",
        invalidEmail: "请输入有效的邮箱地址",
        requiredEmail: "请输入邮箱",
        invalidUsername: "请输入有效的用户名",
        requiredUsername: "请输入用户名",
        invalidPassword: "请输入有效的密码",
        requiredPassword: "请输入密码",
        invalidImage: "请输入有效的图片链接"
      }
    },
    forgetPassword: {
      title: "忘记密码",
      description: "重置密码并重新获得账户访问权限",
      email: "邮箱",
      emailPlaceholder: "请输入邮箱地址",
      submit: "发送重置链接",
      submitting: "发送中...",
      termsNotice: "点击继续即表示您同意我们的",
      termsOfService: "服务条款",
      privacyPolicy: "隐私政策",
      verification: {
        title: "检查您的邮箱",
        sent: "我们已经发送重置密码链接到",
        checkSpam: "找不到邮件？请检查垃圾邮件文件夹。"
      },
      errors: {
        invalidEmail: "请输入有效的邮箱地址",
        requiredEmail: "请输入邮箱"
      }
    },
    resetPassword: {
      title: "重置密码",
      description: "为您的账户创建新密码",
      password: "新密码",
      passwordPlaceholder: "请输入新密码",
      confirmPassword: "确认密码",
      confirmPasswordPlaceholder: "再输入一次新密码",
      submit: "重置密码",
      submitting: "重置中...",
      success: {
        title: "密码重置成功",
        description: "您的密码已经成功重置。",
        backToSignin: "返回登录",
        goToSignIn: "返回登录"
      },
      errors: {
        invalidPassword: "密码长度至少为8个字符",
        requiredPassword: "请输入密码",
        passwordsDontMatch: "两次输入的密码不一致",
        invalidToken: "重置链接无效或已过期，请重试。"
      }
    },
    authErrors: {
      USER_NOT_FOUND: "未找到该邮箱对应的账户",
      USER_ALREADY_EXISTS: "该邮箱已被注册",
      USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "用户已存在，请使用其他邮箱",
      USER_EMAIL_NOT_FOUND: "未找到用户邮箱",
      FAILED_TO_CREATE_USER: "创建用户失败",
      FAILED_TO_UPDATE_USER: "更新用户失败",
      INVALID_EMAIL: "邮箱地址无效",
      INVALID_PASSWORD: "密码无效",
      INVALID_EMAIL_OR_PASSWORD: "邮箱或密码错误",
      INVALID_CREDENTIALS: "提供的凭据无效",
      INVALID_TOKEN: "无效或已过期的令牌",
      PASSWORD_TOO_SHORT: "密码过短",
      PASSWORD_TOO_LONG: "密码过长",
      EMAIL_NOT_VERIFIED: "请先验证您的邮箱地址",
      EMAIL_ALREADY_VERIFIED: "邮箱已验证",
      EMAIL_MISMATCH: "邮箱不匹配",
      EMAIL_CAN_NOT_BE_UPDATED: "邮箱无法更新",
      VERIFICATION_EMAIL_NOT_ENABLED: "验证邮件功能未启用",
      SESSION_EXPIRED: "您的会话已过期，请重新登录",
      SESSION_NOT_FRESH: "会话不是最新的，请重新认证",
      FAILED_TO_CREATE_SESSION: "创建会话失败",
      FAILED_TO_GET_SESSION: "获取会话失败",
      ACCOUNT_NOT_FOUND: "账户未找到",
      ACCOUNT_BLOCKED: "您的账户已被临时冻结",
      CREDENTIAL_ACCOUNT_NOT_FOUND: "凭证账户未找到",
      SOCIAL_ACCOUNT_ALREADY_LINKED: "社交账户已关联",
      LINKED_ACCOUNT_ALREADY_EXISTS: "关联账户已存在",
      FAILED_TO_UNLINK_LAST_ACCOUNT: "无法解除最后一个账户的关联",
      USER_ALREADY_HAS_PASSWORD: "用户已设置密码",
      PROVIDER_NOT_FOUND: "提供商未找到",
      ID_TOKEN_NOT_SUPPORTED: "不支持 ID Token",
      FAILED_TO_GET_USER_INFO: "获取用户信息失败",
      TOO_MANY_REQUESTS: "请求过于频繁，请稍后重试",
      CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: "跨站导航登录被阻止",
      INVALID_ORIGIN: "无效的来源",
      MISSING_OR_NULL_ORIGIN: "来源缺失或无效",
      INVALID_CALLBACK_URL: "无效的回调 URL",
      INVALID_REDIRECT_URL: "无效的重定向 URL",
      INVALID_ERROR_CALLBACK_URL: "无效的错误回调 URL",
      INVALID_NEW_USER_CALLBACK_URL: "无效的新用户回调 URL",
      CALLBACK_URL_REQUIRED: "需要回调 URL",
      VALIDATION_ERROR: "验证错误",
      MISSING_FIELD: "缺少必填字段",
      FIELD_NOT_ALLOWED: "不允许的字段",
      ASYNC_VALIDATION_NOT_SUPPORTED: "不支持异步验证",
      FAILED_TO_CREATE_VERIFICATION: "创建验证失败",
      EMAIL_SEND_FAILED: "邮件发送失败，请稍后重试",
      UNKNOWN_ERROR: "发生未知错误"
    }
  },
  workspace: {
    metadata: {
      title: "Mega - 工作台",
      description: "在您的 Mega 工作台中协作。",
      keywords: "工作台, 协作, Mega"
    },
    title: "工作台",
    description: "您的 Mega 工作台已准备就绪。",
    nav: {
      ariaLabel: "Mega 工作台导航",
      search: "搜索",
      searchAriaLabel: "搜索 Mega 工作台",
      items: {
        home: "主页",
        inbox: "收件箱",
        docs: "文档",
        agent: "智能助手",
        code: "代码",
        tags: "标签",
        cls: "变更列表",
        issues: "议题"
      },
      favorites: "收藏",
      favoritesEmpty: "收藏常用项目，或创建新的收藏项。",
      removeFavorite: "从收藏移除 {title}",
      addFavorite: "添加收藏",
      channels: "频道",
      addChannel: "添加频道",
      newChannel: "新建频道",
      noChannels: "暂无频道。创建一个频道以开始交流。",
      chat: "聊天",
      addChat: "发起聊天",
      newChat: "新建聊天",
      noChats: "暂无私信。与团队成员发起聊天。",
      loading: "正在加载工作台导航",
      loadError: "工作台导航暂时不可用。",
      countsError: "未读计数暂时不可用。",
      retry: "重试",
      unread: "未读",
      openChangeLists: "个开放变更列表",
      mentions: "提及",
      presence: {
        online: "在线",
        away: "离开",
        offline: "离线",
        busy: "忙碌"
      },
      currentUser: "当前用户",
      openProfile: "打开个人资料设置",
      userLoading: "正在加载用户"
    },
    palette: {
      title: "命令面板",
      inputPlaceholder: "搜索 Mega 或快速跳转…",
      empty: "未找到结果。",
      loading: "检索中…",
      error: "检索暂时不可用，请稍后重试。",
      groups: {
        navigation: "导航",
        actions: "快捷动作",
        issues: "议题",
        cls: "变更列表",
        docs: "文档",
        files: "文件",
        bodyDocs: "文档正文",
        bodyIssues: "议题正文",
        bodyCls: "变更列表正文",
        bodyComments: "评论",
        bodyMessages: "消息"
      },
      bodyTypeBadge: {
        doc: "文档",
        issue: "议题",
        cl: "变更",
        doc_comment: "文档评论",
        issue_comment: "评论",
        cl_comment: "评论",
        chat_message: "消息"
      },
      actions: {
        newCl: "新建变更列表",
        reportIssue: "报告议题",
        askAgent: "询问智能助手",
        writeDoc: "撰写文档"
      }
    },
    home: {
      greetings: {
        day: "你好，{name}",
        morning: "早上好，{name}",
        afternoon: "下午好，{name}",
        evening: "晚上好，{name}"
      },
      fallbackName: "朋友",
      askAgent: "问 Agent",
      newDoc: "新建文档",
      loading: "正在加载工作台仪表盘",
      error: "仪表盘暂时不可用。",
      retry: "重试",
      kpis: {
        reviewsRequested: "待我 review",
        mentions: "@我",
        myOpenIssues: "我的 open issue",
        mainCI: "CI · main",
        agentSessions: "Agent 会话",
        sessionsToday: "{count} 今日",
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
          title: "待我 review 的 CL",
          action: "全部",
          empty: "暂无待你 review 的变更列表。"
        },
        assignedIssues: {
          title: "指派给我的 Issue",
          action: "全部",
          empty: "暂无指派给你的议题。"
        },
        activity: {
          title: "动态",
          action: "收件箱",
          empty: "暂无最新动态。",
          updated: "{actor} 更新了 {ref}"
        },
        latestRelease: {
          title: "最新发布",
          action: "标签",
          latest: "最新",
          empty: "暂无发布。"
        },
        agentSessions: {
          title: "最近 Agent 会话",
          action: "Agent",
          empty: "暂无 Agent 会话。"
        },
        recentDocs: {
          title: "最近文档",
          action: "文档",
          empty: "暂无文档。"
        },
        activeChannels: {
          title: "活跃频道",
          unread: "未读",
          empty: "暂无活跃频道。"
        },
        quickActions: {
          title: "快捷入口",
          newCl: "新建 CL",
          reportIssue: "报 Issue",
          askAgent: "问 Agent",
          writeDoc: "写文档",
          searchCode: "搜索代码",
          draftRelease: "草拟 release"
        }
      }
    },
    code: {
      loading: "正在加载代码根视图",
      error: "代码视图暂时不可用。",
      retry: "重试",
      header: {
        monorepoChip: "monorepo",
        publicChip: "public",
        branchSelectorAriaLabel: "切换分支",
        starAriaLabel: "收藏此工作区",
        starUnavailable: "Code 使用 mega2 后端时暂不支持收藏。",
        unstarAriaLabel: "取消收藏此工作区",
        packagesCount: "{count} 个包",
        activeCls: "{count} 个进行中的变更列表",
        newCl: "新建 CL"
      },
      stats: {
        packages: "包",
        openCls: "开放 CL",
        openIssues: "开放议题",
        contributors: "贡献者",
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
        searchPlaceholder: "搜索文件、包、符号…",
        sortBy: "排序",
        sortName: "名称",
        sortUpdated: "更新时间",
        pkgBadge: "pkg",
        empty: "此目录为空。",
        columns: {
          name: "名称",
          lastChange: "最后变更",
          owner: "负责人",
          updated: "更新时间"
        }
      },
      quickLinks: {
        openClsTitle: "{count} 个开放变更列表",
        openIssuesTitle: "{count} 个开放议题",
        p1Count: "{count} 个 P1",
        assignedToYou: "{count} 个指派给你"
      },
      file: {
        treeAriaLabel: "工作区文件树",
        notFoundTitle: "路径不存在",
        notFoundBody: "“{path}”在此工作区中不存在。",
        backToCode: "返回代码",
        contentUnavailable: "无法加载文件内容。",
        contentPlaceholder: "文件内容将在此渲染。",
        dir: {
          name: "名称",
          empty: "此目录为空。"
        },
        header: {
          breadcrumbAriaLabel: "文件路径面包屑",
          raw: "Raw",
          tabsAriaLabel: "文件视图标签",
          tabs: {
            preview: "预览",
            code: "代码",
            blame: "Blame",
            history: "历史"
          },
          deferredTooltip: "后续里程碑提供，本期未实现",
          previewUnavailableTooltip: "仅 Markdown 文件支持预览",
          linesCount: "{count} 行",
          actionsAriaLabel: "文件操作",
          copy: "复制",
          copied: "已复制！",
          download: "下载",
          edit: "编辑",
          editTooltip: "编辑经由变更列表进行",
          newCl: "新建 CL",
          contentUnavailable: "内容不可用"
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
        ciDuration: "{minutes} 分 {seconds} 秒",
        owners: "负责人",
        flags: "特性开关",
        sparseCheckout: "Sparse checkout",
        codexIndexed: "Codex 索引",
        enabled: "已启用",
        ready: "就绪",
        off: "关闭",
        dependencies: "依赖",
        usedBy: "被使用",
        outline: "大纲",
        openCls: "开放 CL",
        recentActivity: "最近动态",
        updatedActivity: "{actor} 更新了 {ref}",
        noPackage: "此路径不属于任何包。",
        noData: "—",
        loadError: "变更列表暂时不可用。",
        retry: "重试"
      }
    },
    tags: {
      title: "Tags",
      subtitle: "发布版本 · git tag",
      loading: "正在加载版本",
      error: "版本暂时不可用。",
      retry: "重试",
      viewAriaLabel: "Tags 视图",
      viewReleases: "Releases",
      viewTags: "Tags",
      draftRelease: "草拟 release",
      draftDate: "草稿",
      pillLatest: "Latest",
      pillPrerelease: "Pre-release",
      pillMajor: "Major",
      card: {
        draft: "DRAFT",
        commitsSince: "自 {since} 起 {count} 个提交",
        compare: "比较",
        assets: {
          title: "Assets",
          name: "文件",
          size: "大小",
          downloads: "下载数",
          downloadAriaLabel: "下载 {name}"
        }
      },
      flat: {
        tableAriaLabel: "标签列表",
        tag: "Tag",
        sha: "SHA",
        date: "日期"
      },
      draftDialog: {
        title: "草拟 release",
        tagLabel: "Tag",
        tagPlaceholder: "v0.4.3",
        titleLabel: "标题",
        titlePlaceholder: "git-internal 0.4.3",
        notesLabel: "发布说明",
        notesPlaceholder: "有哪些变更？可用 !1208 引用 CL…",
        cancel: "取消",
        submit: "创建草稿",
        submitting: "创建中…",
        genericError: "无法创建草稿。"
      },
      publish: "发布",
      publishSuccess: "已发布",
      publishConflict: "该 release 已发布过",
      publishError: "无法发布"
    },
    session: {
      loading: "正在加载会话",
      notFound: "会话不存在或暂时不可用。",
      retry: "重试",
      header: {
        breadcrumbAriaLabel: "会话面包屑",
        completed: "completed",
        running: "running",
        pipeNote: "libra → mega · refs/ai/",
        export: "导出 objects",
        deferredTooltip: "后续里程碑提供（本期不做）"
      },
      timeline: {
        timelineAriaLabel: "对象时间线",
        title: "对象图 · {count}",
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
          copyAriaLabel: "复制对象 JSON",
          copied: "已复制"
        }
      },
      rail: {
        sectionScheduler: "Scheduler [L]",
        sectionProvenance: "Provenance [S]",
        sectionRunUsage: "RunUsage [E]",
        sectionDecision: "Decision [E]",
        sectionEvidence: "Evidence [E]",
        sectionOutputs: "产出",
        outputCLAriaLabel: "打开产出的 change list",
        copyRefAriaLabel: "复制 thread ref",
        copiedRef: "已复制"
      }
    },
    agent: {
      loading: "正在加载 Agent",
      notFound: "对话不存在或暂时不可用。",
      retry: "重试",
      askError: "Agent 暂时无法回答，请重试。",
      streamError: "Agent 流式回答中断，请重试。",
      llmDisabledTitle: "尚未配置 Agent LLM",
      llmDisabledBody: "配置 LLM 提供方后即可提问。现有对话仍可浏览。",
      searching: "正在检索 {scope} …",
      rail: {
        railAriaLabel: "Agent 对话",
        newThread: "新对话",
        recent: "最近",
        untitled: "新对话"
      },
      header: {
        title: "Mega Agent",
        indexLine: "已索引 {count} 个 package · Codex 更新于",
        scope: "scope",
        scopeAriaLabel: "检索范围",
        allPackages: "全部 package",
        deferredTooltip: "后续里程碑提供（本期不做）"
      },
      answer: {
        copy: "复制",
        copied: "已复制",
        helpful: "有用",
        regenerate: "重新生成"
      },
      composer: {
        placeholder: "问 Mega Agent 关于代码、CL 或架构的任何问题…",
        inputAriaLabel: "Agent 提问",
        sendAriaLabel: "发送提问",
        suggestedAriaLabel: "建议提问",
        provenanceNote: "Codex 检索 · 引用可溯源",
        addChipAriaLabel: "添加文件上下文 chip",
        addChipPlaceholder: "path/to/file.rs",
        removeChipAriaLabel: "移除上下文 chip {chip}"
      },
      sources: {
        panelAriaLabel: "来源与范围",
        sectionCitations: "本轮引用来源",
        noCitations: "回答完成后，这里显示引用来源。",
        sectionScope: "检索范围",
        indexed: "已索引",
        optional: "可选",
        scopeHint: "包含 main 分支代码、CL diff、Docs 与 Issues。",
        sectionActions: "快捷动作",
        actionCreateCL: "基于回答创建 CL",
        actionCreateIssue: "创建 issue",
        actionSaveDoc: "存为文档",
        actionShare: "分享对话",
        deferredTooltip: "后续里程碑提供（本期不做）"
      }
    },
    chat: {
      loading: "正在加载频道",
      notFound: "频道不存在或暂时不可用。",
      retry: "重试",
      sendError: "消息发送失败。",
      editError: "消息编辑失败。",
      reactionError: "表情反应保存失败。",
      markAsRead: "标为已读",
      jumpToMention: "跳转到提及",
      typingAriaLabel: "{name} 正在输入",
      intro: "这是 {name} 的频道起点。每个 package 自动挂载一个频道，消息可引用 CL、commit、symbol。",
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
        deferredTooltip: "后续里程碑提供（本期不做）",
        membersAriaLabel: "频道成员",
        memberCountAriaLabel: "{count} 位成员",
        privateBadge: "私有",
        openMembersAriaLabel: "打开频道成员"
      },
      members: {
        title: "成员",
        close: "关闭",
        empty: "暂无成员",
        inviteHeading: "邀请成员",
        inviteSearchPlaceholder: "搜索工作区用户",
        inviteButton: "邀请",
        inviteEmpty: "没有匹配的用户",
        remove: "移除",
        leave: "退出",
        roleAdmin: "管理员",
        roleMember: "成员",
        privateBadge: "私有",
        inviteError: "邀请失败",
        removeError: "无法更新成员"
      },
      create: {
        title: "创建频道",
        nameLabel: "名称",
        topicLabel: "主题（可选）",
        visibilityLabel: "可见性",
        visibilityPublic: "公开",
        visibilityPrivate: "私有",
        submit: "创建频道",
        error: "无法创建频道"
      },
      tabs: {
        tabsAriaLabel: "频道视图",
        messages: "Messages",
        cls: "CLs",
        files: "Files",
        pinned: "Pinned",
        about: "About",
        deferredTooltip: "后续里程碑提供（本期不做）"
      },
      list: {
        listAriaLabel: "消息列表",
        jumpToLatest: "回到底部",
        threadReplies: "{count} 条回复",
        threadLastReply: "最后回复",
        edited: "（已编辑）",
        edit: "编辑",
        cancelEdit: "取消",
        saveEdit: "保存",
        day: {
          today: "今天",
          yesterday: "昨天"
        }
      },
      composer: {
        placeholder: "发消息到 #{name} … 用 @ 提及，用 ! 引用 CL",
        inputAriaLabel: "消息输入框",
        sendAriaLabel: "发送消息",
        sendHint: "⌘Enter 发送",
        cmdEnterHint: "⌘/Ctrl+Enter 发送",
        attachCL: "Attach CL",
        deferredTooltip: "后续里程碑提供（本期不做）",
        lookupUsersAriaLabel: "提及候选",
        lookupClsAriaLabel: "CL 候选",
        edited: "（已编辑）",
        edit: "编辑",
        saveEdit: "保存",
        cancelEdit: "取消",
        format: {
          ariaLabel: "文本格式",
          bold: "加粗",
          italic: "斜体",
          strikethrough: "删除线",
          code: "行内代码",
          link: "链接",
          linkPlaceholder: "https://…"
        },
        slashMenu: {
          ariaLabel: "插入块",
          heading1: "一级标题",
          heading2: "二级标题",
          heading3: "三级标题",
          unorderedList: "无序列表",
          orderedList: "有序列表",
          checklist: "待办列表",
          quote: "引用",
          code: "代码块",
          table: "表格",
          divider: "分隔线"
        },
        wikilinks: {
          ariaLabel: "链接建议",
          createPage: "创建「{title}」",
          empty: "没有匹配的页面"
        }
      },
      dm: {
        notFound: "会话不存在或暂时不可用。",
        readReceipt: "已读",
        typingAriaLabel: "{name} 正在输入",
        intro: "这是你和 {name} 的私聊起点。你们共同参与",
        introSeparator: "、",
        introEnd: "。",
        placeholder: "发消息给 {name} …",
        header: {
          deferredTooltip: "后续里程碑提供（本期不做）",
          localTime: "本地时间 {time}",
          sharedPackages: "共同 package · {count}",
          sharedPackagesAriaLabel: "共同 package",
          presence: {
            online: "在线",
            away: "离开",
            offline: "离线",
            busy: "忙碌"
          }
        }
      },
      thread: {
        title: "线程",
        closeAriaLabel: "关闭线程",
        loading: "正在加载线程…",
        notFound: "该线程不存在于此频道。",
        replyError: "回复发送失败。",
        replyPlaceholder: "回复线程…",
        replyAriaLabel: "线程回复",
        sendAriaLabel: "发送回复"
      }
    },
    settings: {
      loading: "正在加载设置",
      error: "设置暂时不可用。",
      retry: "重试",
      nav: {
        title: "设置",
        navAriaLabel: "设置分区",
        account: "账户",
        preferences: "偏好",
        profile: "个人资料",
        accountSecurity: "账号与安全",
        keys: "SSH / GPG 密钥",
        tokens: "个人访问令牌",
        appearance: "外观",
        notifications: "通知",
        shortcuts: "键盘快捷键",
        deferredTooltip: "后续里程碑提供（本期不做）"
      },
      ssh: {
        title: "SSH 密钥",
        pageTitle: "SSH / GPG 密钥",
        pageDesc: "用于通过 SSH 拉取 / 推送仓库的密钥，与登录会话无关。",
        sectionLabel: "SSH 密钥",
        add: "添加 SSH 密钥",
        emptyTitle: "还没有 SSH key",
        emptyDesc: "添加 SSH key 后即可通过 SSH 协议 push / pull 仓库，无需每次输入密码。",
        emptyHint: "ssh-keygen -t ed25519 -C \"you@example.com\"",
        loadError: "加载密钥失败，请重试。",
        retry: "重试",
        addedOn: "添加于 {date}",
        addModalTitle: "添加 SSH key",
        titleField: "标题",
        titlePlaceholder: "例如 MacBook Pro (work)",
        publicKeyField: "公钥",
        publicKeyHint: "粘贴 ~/.ssh/id_ed25519.pub 的完整内容。",
        addConfirm: "添加 SSH key",
        cancel: "取消",
        addSuccess: "SSH 密钥已添加。",
        addError: "无法添加 SSH 密钥。",
        deleteModalTitle: "删除 SSH key？",
        deleteWarning: "删除后使用「{title}」的设备将无法再拉取或推送仓库。",
        deleteConfirm: "删除",
        deleteSuccess: "SSH 密钥已删除。",
        deleteError: "无法删除 SSH 密钥。",
        gpgSection: "GPG 密钥",
        gpgDesc: "用于验证 commit 签名。后端支持建设中。",
        gpgPhase2: "Phase 2",
        gpgAddDisabled: "添加 GPG key",
      },
      tokens: {
        title: "个人访问令牌",
        pageTitle: "个人访问令牌",
        pageDesc: "用于脚本、CI 或命令行工具以你的身份访问 Mega API。",
        securityHint: "令牌等同于密码，请妥善保管，切勿提交到仓库或分享给他人。",
        sectionLabel: "令牌",
        generate: "生成新令牌",
        emptyTitle: "还没有访问令牌",
        emptyDesc: "生成令牌供脚本或自动化任务调用 API。",
        loadError: "加载令牌失败，请重试。",
        retry: "重试",
        maskedToken: "令牌",
        created: "创建于",
        generateSuccess: "令牌已生成。",
        generateError: "无法生成令牌。",
        revealTitle: "令牌已生成",
        revealHint: "请立即复制 — 关闭此窗口后将无法再次查看完整令牌。",
        revealConfirm: "完成",
        revealCloseConfirm: "尚未复制令牌，确定关闭？",
        copy: "复制",
        copyError: "无法复制到剪贴板。",
        copied: "已复制到剪贴板。",
        cancel: "取消",
        deleteModalTitle: "删除令牌？",
        deleteWarning: "使用此令牌的应用将立即失去访问权限。",
        deleteConfirm: "删除",
        deleteSuccess: "令牌已删除。",
        deleteError: "无法删除令牌。",
      },
      accountSecurity: {
        pageTitle: "账户与安全",
        pageDesc: "管理登录方式与账户生命周期。",
        sessionHint: "浏览器登录用于访问 Mega Workspace 界面，与 Git 操作凭据分离。推送 / 拉取仓库需要",
        sshLink: "SSH key",
        tokensLink: "个人访问令牌",
        email: "登录邮箱",
        createdAt: "账户创建时间",
        passwordSection: "密码",
        passwordTitle: "密码由 Better Auth 管理",
        passwordDesc: "修改密码会跳转到独立的安全验证流程。",
        passwordAction: "修改密码 ↗",
        changePasswordTitle: "修改密码",
        changePasswordDesc: "设置新密码后，其他活跃会话将被登出。",
        currentPassword: "当前密码",
        newPassword: "新密码",
        confirmPassword: "确认新密码",
        changePasswordSubmit: "修改密码",
        changePasswordSuccess: "密码已修改，其他会话已登出。",
        changePasswordError: "无法修改密码。",
        passwordMismatch: "两次输入的新密码不一致。",
        passwordTooShort: "新密码至少需要 8 个字符。",
        sessionSection: "会话",
        sessionTitle: "登出所有其他会话",
        sessionDesc: "撤销除当前浏览器以外的全部会话。",
        sessionSummary: "当前活跃会话：{count}。",
        sessionAction: "登出其他会话",
        revokeOtherSuccess: "已登出其他会话。",
        revokeOtherError: "无法登出其他会话。",
        dangerSection: "危险区域",
        deactivateTitle: "停用账户",
        deactivateDesc: "暂时隐藏你的资料，可随时重新登录恢复。",
        deactivateAction: "停用账户",
        deactivateUnavailable: "暂不可用——Better Auth 尚无自助停用 API。",
        deleteTitle: "删除账户",
        deleteDesc: "永久删除账户与个人数据。commit / CL 历史会保留但作者将显示为已注销用户。",
        deleteAction: "删除账户",
        deleteModalTitle: "删除账户？",
        deleteModalSub: "此操作不可撤销",
        deleteWarning: "你的 commit 与 CL 历史会保留，但作者信息将显示为已注销用户。SSH key 与访问令牌将立即失效。",
        deleteConfirmHint: "请输入用户名 {username} 以确认",
        deleteConfirm: "永久删除",
        deleteSuccess: "账户已删除。",
        deleteError: "无法删除账户。",
        usernameRequired: "请准确输入用户名以确认。",
        cancel: "取消",
        loadError: "无法加载账户与安全设置。",
        retry: "重试",
      },
      profile: {
        title: "个人资料",
        subtitle: "你在工作区中的展示信息。",
        avatarChange: "更换头像",
        avatarModalTitle: "更换头像",
        avatarUploadCta: "点击上传图片",
        avatarFileHelp: "PNG、JPG、GIF 或 WebP，最大 1MB。",
        avatarUrlLabel: "粘贴图片 URL",
        avatarUrlPlaceholder: "https://…",
        avatarRemove: "移除当前头像",
        avatarCancel: "取消",
        avatarSave: "保存头像",
        avatarSaving: "保存中…",
        avatarTooLarge: "请选择小于 1MB 的图片。",
        avatarTypeInvalid: "请选择图片文件。",
        avatarSaveSuccess: "头像已更新。",
        avatarSaveError: "无法更新头像。",
        displayName: "显示名",
        displayNameRequired: "请输入显示名（最多 60 个字符）。",
        username: "用户名",
        usernameHint: "注册时设置，注册后不可修改。",
        usernameInvalid: "用户名只能包含小写字母、数字和连字符（2–31 个字符，以字母或数字开头）。",
        email: "邮箱",
        emailHint: "在「账号与安全」中管理。",
        bio: "简介",
        bioTooLong: "简介最多 280 个字符。",
        cancel: "取消",
        save: "保存修改",
        saving: "保存中…",
        saveSuccess: "个人资料已更新。",
        saveError: "无法保存个人资料。"
      },
      notificationsPage: {
        pageTitle: "通知",
        pageDesc: "管理工作区事件如何通知你。这些设置由 mega2 保存，适用于 Change List、Issue 与引用事件。",
        loading: "正在加载通知设置",
        loadError: "加载通知设置失败，请重试。",
        retry: "重试",
        globalSection: "全局",
        globalTitle: "启用通知",
        globalDesc: "关闭后，此账户将不再接收工作区通知投递。",
        globalToggleAriaLabel: "开关全部通知",
        deliverySection: "投递",
        deliveryMode: "投递方式",
        deliveryHint: "mega2 当前接受应用内或邮件投递。",
        preferredLocale: "首选语言",
        localeHint: "后端生成本地化通知内容时使用。",
        preferencesSection: "事件偏好",
        preferenceToggleAriaLabel: "开关 {setting}",
        systemRequired: "必需",
        systemRequiredHint: "此事件为系统必需，不能关闭。",
        save: "保存投递设置",
        saving: "保存中…",
        saveSuccess: "通知设置已保存。",
        saveError: "无法保存通知设置。",
        toggleError: "无法更新通知设置。",
        unsupportedDeliveryMode: "不可编辑",
        profileCardTitle: "通知设置已移至独立页面",
        profileCardDesc: "可在通知页面统一设置投递方式、语言和事件级偏好。",
        profileCardAction: "打开通知设置",
        deliveryModeLabels: {
          in_app: "应用内",
          email: "邮件",
          realtime: "实时"
        },
        localeLabels: {
          "zh-CN": "中文（简体）",
          en: "English"
        },
        categoryLabels: {
          cl: "Change List",
          issue: "Issue",
          reference: "引用",
        },
        eventLabels: {
          "cl.comment.created": "新的 CL 评论",
          "cl.merged": "CL 已合并",
          "issue.comment.created": "新的 Issue 评论",
          "issue.closed": "Issue 已关闭",
          "item.referenced": "条目被引用"
        }
      },
      shortcutsPage: {
        pageTitle: "键盘快捷键",
        pageDesc: "只读快捷键参考。本阶段暂不支持自定义按键绑定。",
        macColumn: "Mac",
        windowsColumn: "Windows / Linux",
        then: "然后",
        groups: {
          navigation: "导航",
          code: "Code 视图",
          cl: "Change List",
          issue: "Issue",
        },
        actions: {
          commandPalette: "命令面板",
          goCode: "跳转到 Code",
          goIssues: "跳转到 Issues",
          goCls: "跳转到 Change Lists",
          goInbox: "跳转到 Inbox",
          searchFilename: "按文件名搜索",
          findInFile: "查找文件内容",
          toggleBlame: "切换 Blame",
          copyPermalink: "复制永久链接",
          submitComment: "提交评论",
          expandDiffs: "展开 / 折叠全部 diff",
          nextPrevFile: "下一个 / 上一个文件",
          markViewed: "标记为已查看",
          newIssue: "新建 Issue",
          toggleIssueState: "关闭 / 重新打开 Issue",
        },
      },
      appearance: {
        title: "外观",
        theme: "主题",
        modeAriaLabel: "主题模式",
        modeLight: "浅色",
        modeDark: "深色",
        modeSystem: "跟随系统",
        accent: "强调色",
        accentSwatchAriaLabel: "使用强调色 {color}",
        density: "密度",
        densityComfortable: "宽松",
        densityCompact: "紧凑"
      }
    },
    inbox: {
      loading: "正在加载通知",
      error: "通知暂时不可用。",
      retry: "重试",
      rail: {
        title: "Inbox",
        filters: "通知过滤",
        all: "全部",
        mentions: "@我",
        replies: "回复",
        dm: "私信",
        invite: "邀请",
        saved: "已保存",
        markAllRead: "全部标为已读",
        markAllReadError: "无法将通知标为已读。",
        settings: "通知设置",
        deferredTooltip: "稍后提供（本里程碑范围外）"
      },
      list: {
        listAriaLabel: "通知列表",
        unreadSummary: "{count} 条未读",
        sortUnreadFirst: "未读优先",
        sortLatest: "最新",
        empty: "收件箱清空啦！",
        emptyHint: "这里暂时没有需要你关注的内容——新的提及、回复、私信与邀请会出现在这个列表。"
      },
      pane: {
        emptySelection: "选择一条通知开始阅读。",
        loading: "加载中…",
        save: "保存",
        saved: "已保存",
        markRead: "标为已读",
        markedRead: "已读",
        contextTitle: "相关上下文",
        reviewStart: "开始 review",
        reviewViewDiff: "查看 diff",
        reviewLater: "稍后",
        kindTitles: {
          mention: "提及",
          reply: "回复",
          dm: "私信",
          invite: "频道邀请",
          review: "Review 请求",
          ci: "CI 通过",
          cifail: "CI 失败",
          issue: "议题更新"
        },
        fanoutTitles: {
          mention: "{actor} 在 {channel} 提到了你",
          reply: "{actor} 在 {channel} 回复了你",
          dm: "{actor} 给你发了私信",
          invite: "{actor} 邀请你加入 {channel}"
        },
        open: {
          mention: "打开会话",
          reply: "打开会话",
          dm: "打开私信",
          invite: "打开频道",
          review: "打开变更列表",
          ci: "打开检查",
          cifail: "打开检查",
          issue: "打开议题"
        },
        states: {
          wip: "WIP",
          ready: "就绪",
          queued: "队列中",
          conflicts: "冲突",
          merged: "已合并",
          closed: "已关闭"
        },
        quickReply: {
          placeholder: "快速回复…",
          sendAriaLabel: "发送快速回复",
          sent: "回复已发送",
          failed: "无法发送回复。"
        }
      }
    },
    docs: {
      loading: "正在加载文档",
      error: "文档暂时不可用。",
      retry: "重试",
      empty: "没有符合过滤条件的文档。",
      apiErrors: {
        TITLE_CONFLICT: "已存在同名文档。",
        MEGA_CONFLICT: "文档已在其他位置被更新，请刷新后重试。",
        MEGA_NOT_FOUND: "未找到文档。",
        MEGA_BAD_REQUEST: "无效的文档请求。"
      },
      sidebar: {
        title: "Mega Docs",
        newDoc: "新建文档",
        allDocs: "All Docs",
        graph: "链接图谱",
        tasks: "Tasks",
        calendar: "Calendar",
        imagine: "Imagine",
        shared: "Shared with Me",
        starred: "Starred",
        starredEmpty: "置顶你最常读的文档 — 点击 ★ 收藏。",
        folders: "Folders",
        unsorted: "未分类",
        tags: "Tags",
        deferredTooltip: "稍后提供（本里程碑范围外）"
      },
      graph: {
        title: "链接图谱",
        loading: "正在加载链接图谱…",
        error: "链接图谱不可用。",
        retry: "重试",
        empty: "暂无链接。在文档中添加 [[wikilink]] 或嵌入即可生成图谱。",
        graphAriaLabel: "工作区链接图谱",
        legendWikilink: "双向链接",
        legendEmbed: "嵌入",
        legendDoc: "文档",
        legendIssue: "议题",
        legendCl: "变更",
        issueAriaLabel: "议题 #{number}",
        clAriaLabel: "变更 !{number}"
      },
      header: {
        allTitle: "All Docs",
        stats: "{count} 份 · {folders} 个目录 · {authors} 位作者",
        searchAriaLabel: "搜索文档",
        searchPlaceholder: "搜索文档、标签、@人",
        viewAriaLabel: "视图模式",
        viewGrid: "Grid",
        viewWall: "Wall",
        viewList: "List",
        sortUpdated: "按更新时间 ↓",
        sortTitle: "按标题 A–Z",
        newDoc: "新建文档",
        deferredTooltip: "稍后提供（本里程碑范围外）"
      },
      newDialog: {
        title: "新建文档",
        titleLabel: "标题",
        titlePlaceholder: "这篇文档写什么？",
        folderLabel: "文件夹",
        tagsLabel: "标签",
        cancel: "取消",
        submit: "创建并编辑",
        submitting: "创建中…"
      },
      card: {
        starAriaLabel: "收藏 {title}",
        unstarAriaLabel: "取消收藏 {title}",
        commentsAriaLabel: "{count} 条评论"
      }
    },
    docDetail: {
      publication: {
        publish: "发布",
        publishing: "正在发布…",
        unpublish: "撤回为草稿",
        unpublishing: "正在撤回…",
        published: "文档已发布。",
        unpublished: "文档已撤回为草稿。",
        publishFailed: "文档发布失败，请重试。",
        unpublishFailed: "撤回为草稿失败，请重试。"
      },
      loading: "正在加载文档",
      error: "文档暂时不可用。",
      retry: "重试",
      notFoundTitle: "文档不存在",
      notFoundBody: "该文档不存在。",
      backToDocs: "返回文档库",
      snapshotBanner: "正在查看历史快照 v{version}（只读）。",
      backToLatest: "回到最新",
      restoreVersion: "恢复此版本",
      restoringVersion: "恢复中…",
      restoreSuccess: "版本已恢复。",
      restoreFailed: "恢复失败。",
      metaEditor: {
        tagToggleAriaLabel: "切换标签 {tag}",
        statusLabel: "状态",
        statusPublished: "已发布",
        statusDraft: "草稿",
        starAriaLabel: "收藏 {title}",
        unstarAriaLabel: "取消收藏 {title}"
      },
      versions: {
        title: "历史版本",
        versionLine: "{version} · {time} · {summary}",
        versionAriaLabel: "查看 v{version} 快照"
      },
      toc: {
        title: "目录",
        readingTime: "阅读约 {minutes} 分钟",
        versions: "{count} 个历史版本"
      },
      toolbar: {
        breadcrumbDocs: "Docs",
        share: "分享",
        copied: "链接已复制",
        history: "历史",
        exportDoc: "导出",
        edit: "编辑",
        rename: "重命名",
        renameSave: "保存",
        renameCancel: "取消",
        renameAriaLabel: "文档标题",
        deferredTooltip: "稍后提供（本里程碑范围外）",
        presenceAriaLabel: "在线编辑者",
        shareDialog: {
          title: "分享文档",
          close: "关闭",
          copyLink: "复制链接",
          copied: "链接已复制",
          defaultOpenNote: "访问默认拒绝：仅有权限的用户可打开此文档。",
          collaboratorsHeading: "协作者",
          collaboratorsEmpty: "暂无显式协作者。",
          copyFailed: "无法复制链接。",
          roleOwner: "所有者",
          roleEditor: "编辑者",
          roleViewer: "查看者"
        }
      },
      article: {
        createdAt: "创建于 {time}",
        updatedAt: "最近编辑 {time}",
        viewsAriaLabel: "{count} 次浏览",
        commentsAriaLabel: "{count} 条评论",
        statusPublished: "已发布",
        statusDraft: "草稿",
        emptyBody: "这篇文档还是空的。",
        openEditor: "打开编辑器开始按块写作",
        createRefPage: "创建「{title}」",
        blockRefs: {
          copyRef: "复制引用",
          unresolved: "未解析的块",
          forbidden: "无权限"
        },
        embeds: {
          cycle: "循环嵌入",
          tooDeep: "嵌入嵌套超过深度上限",
          unresolved: "未解析的嵌入",
          noAccess: "无权限",
          loading: "正在加载嵌入…",
          openSource: "打开源文档"
        },
        zoom: {
          breadcrumbAriaLabel: "缩放面包屑",
          pageCrumb: "整页",
          backToFullPage: "返回整页",
          zoom: "缩放",
          collapse: "折叠",
          expand: "展开",
          copyBlockRef: "复制块引用",
          menuAriaLabel: "块操作",
          copyDeepLink: "复制块链接",
          deleteBlock: "删除块",
          deleteConfirm: "删除此块？",
          deleteConfirmAction: "删除",
          deleteCancel: "取消",
          copySubtree: "复制块",
          cutBlock: "剪切块",
          insertBelow: "在下方插入",
          insertAbove: "在上方插入",
          turnInto: "转换为…",
          turnH1: "标题 1",
          turnH2: "标题 2",
          turnH3: "标题 3",
          turnText: "正文",
          turnQuote: "引用",
          turnTodo: "待办",
          turnCode: "代码块",
          openInSidePanel: "在侧栏打开",
          othersEditing: "他人正在编：{names}",
          sidePanelAriaLabel: "块侧栏",
          sidePanelClose: "关闭侧栏",
          sidePanelInvalid: "该块不存在或不可用。"
        }
      },
      meta: {
        collaborators: "协作者",
        roleAuthor: "作者",
        roleEditor: "编辑",
        tags: "标签",
        linked: "关联",
        recentVersions: "最近版本",
        versionLine: "{version} · {time} · {summary}",
        none: "无",
        backlinks: {
          title: "反向链接",
          empty: "还没有页面链接到这里。",
          unlinkedTitle: "未链接提及",
          unlinkedEmpty: "没有未链接提及。",
          convertLink: "转为链接",
          converting: "转换中…",
          typeDoc: "文档",
          typeIssue: "议题",
          typeCl: "变更",
          typeOther: "引用",
          blockContext: "被引用块：{summary}"
        }
      },
      comments: {
        title: "评论（{count}）",
        empty: "还没有评论，来开启讨论吧。",
        addReaction: "添加表情",
        authorRole: "作者",
        typingAriaLabel: "{name} 正在输入",
        commentAdded: "评论已添加。",
        actionFailed: "操作失败。",
        composer: {
          close: "关闭",
          closing: "正在关闭…",
          placeholder: "发表评论…",
          preview: "预览",
          previewEmpty: "暂无可预览内容",
          submit: "评论",
          submitting: "正在发表…",
          write: "编辑",
          cmdEnterHint: "⌘Enter 发表评论"
        }
      }
    },
    docEdit: {
      loading: "正在加载文档",
      error: "文档暂时不可用。",
      retry: "重试",
      notFoundTitle: "文档不存在",
      backToDocs: "返回文档库",
      backToDoc: "返回文档",
      placeholder: "开始书写 — 支持 Markdown 快捷输入（#、>、-、- [ ]、```）…",
      saveVersion: "保存版本",
      saveVersionSubmit: "保存",
      versionSummaryAriaLabel: "版本摘要",
      versionSummaryPlaceholder: "改了什么？（必填）",
      mentionAriaLabel: "提及建议",
      wikilinks: {
        ariaLabel: "链接建议",
        createPage: "创建「{title}」",
        empty: "没有匹配的页面"
      },
      quickCommands: {
        ariaLabel: "快捷命令",
        todo: "待办",
        table: "表格",
        image: "图片",
        pageReference: "页面引用",
        blockReference: "块引用",
        tagPage: "页面标签"
      },
      todoCheckbox: {
        markComplete: "标记待办为已完成",
        markIncomplete: "标记待办为未完成"
      },
      blockCollapse: {
        collapse: "折叠块",
        expand: "展开块"
      },
      blockContextMenu: {
        ariaLabel: "块操作",
        copyBlockRef: "复制块引用",
        copyBlockId: "复制块 ID",
        copyBlockLink: "复制块链接",
        copyEmbed: "复制嵌入",
        focusBlock: "定位到块",
        openInSidebar: "在侧栏打开",
        expandAll: "全部展开",
        collapseAll: "全部折叠",
        makeTodo: "设为待办",
        removeTodo: "取消待办",
        textStyle: "文字样式",
        heading1: "一级标题",
        heading2: "二级标题",
        heading3: "三级标题"
      },
      sidePanel: {
        resize: "调整块侧栏宽度",
        ariaLabel: "块侧栏",
        breadcrumbAriaLabel: "块路径",
        close: "关闭",
        invalid: "此块已不存在",
        referenceCount: "{count} 次引用"
      },
      images: {
        dialog: "插入图片",
        url: "图片网址",
        alt: "图片描述",
        file: "或上传文件",
        insert: "插入",
        cancel: "取消",
        invalid: "请选择 PNG、JPEG、GIF、WebP 或 BMP 图片，或输入有效的 HTTP(S) 网址。",
        uploading: "正在上传图片…"
      },
      tableControls: {
        addRow: "添加行",
        addColumn: "添加列",
        deleteRow: "删除行",
        deleteColumn: "删除列",
        deleteTable: "删除表格"
      },
      blockRefs: {
        ariaLabel: "块引用建议",
        empty: "没有匹配的块",
        copyRef: "复制引用",
        unresolved: "未解析的块",
        forbidden: "无权限"
      },
      embeds: {
        ariaLabel: "嵌入建议",
        empty: "没有匹配的页面或块",
        pagesGroup: "页面",
        blocksGroup: "块",
        cycle: "循环嵌入",
        tooDeep: "嵌入嵌套超过深度上限",
        unresolved: "未解析的嵌入",
        noAccess: "无权限",
        loading: "正在加载嵌入…",
        openSource: "打开源文档"
      },
      slashMenu: {
        ariaLabel: "插入块",
        heading1: "标题 1",
        heading2: "标题 2",
        heading3: "标题 3",
        unorderedList: "无序列表",
        orderedList: "有序列表",
        checklist: "勾选列表",
        quote: "引用",
        code: "代码块",
        table: "表格",
        divider: "分割线"
      },
      floatingToolbar: {
        ariaLabel: "文本格式",
        bold: "加粗",
        italic: "斜体",
        strikethrough: "删除线",
        code: "行内代码",
        link: "链接",
        linkPlaceholder: "https://…"
      },
      codeLanguageAriaLabel: "代码块语言",
      autoSaveHint: "停止输入 2 秒后自动保存",
      saving: "保存中…",
      saved: "已保存",
      collabConnecting: "连接中…",
      collabConnected: "实时同步",
      collabOffline: "离线 — 本地已保留编辑",
      collabLive: "实时协作中",
      collabReadonly: "协作不可用 — 只读",
      presenceAriaLabel: "在线编辑者",
      zoom: {
        breadcrumbAriaLabel: "缩放面包屑",
        pageCrumb: "整页",
        backToFullPage: "返回整页",
        zoom: "缩放",
        collapse: "折叠",
        expand: "展开",
        copyBlockRef: "复制块引用",
        menuAriaLabel: "块操作",
        copyDeepLink: "复制块链接",
        deleteBlock: "删除块",
        deleteConfirm: "删除此块？",
        deleteConfirmAction: "删除",
        deleteCancel: "取消",
        copySubtree: "复制块",
        cutBlock: "剪切块",
        insertBelow: "在下方插入",
        insertAbove: "在上方插入",
        turnInto: "转换为…",
        turnH1: "标题 1",
        turnH2: "标题 2",
        turnH3: "标题 3",
        turnText: "正文",
        turnQuote: "引用",
        turnTodo: "待办",
        turnCode: "代码块",
        openInSidePanel: "在侧栏打开",
        othersEditing: "他人正在编：{names}",
        sidePanelAriaLabel: "块侧栏",
        sidePanelClose: "关闭侧栏",
        sidePanelInvalid: "该块不存在或不可用。"
      }
    },
    clsList: {
      title: "变更列表",
      replacesPr: "CL 取代 Pull Request",
      newCl: "新建 CL",
      filterAriaLabel: "过滤变更列表",
      filterPlaceholder: "is:open reviewer:@me pkg:*",
      loading: "正在加载变更列表",
      error: "变更列表暂时不可用。",
      retry: "重试",
      empty: "没有符合过滤条件的变更列表。",

      pageSize: 20,
      pagination: {
        previous: "上一页",
        next: "下一页",
        pageStatus: "第 {page} / {total} 页"
      },
      row: {
        atomic: "ATOMIC",
        pkgs: "{count} 个包",
        byRev: "由 {author} · rev {rev}",
        files: "{count}f",
        approvedSummary: "{approved}/{total}",
        reviewersAriaLabel: "审阅者",
        states: {
          wip: "WIP",
          ready: "就绪",
          queued: "队列中",
          conflicts: "冲突",
          merged: "已合并",
          closed: "已关闭"
        },
        ci: {
          passing: "通过",
          failing: "失败",
          queued: "排队中"
        },
        verdicts: {
          approved: "已批准",
          commented: "已评论",
          requested: "待审阅",
          pending: "待处理"
        }
      },
      dropdowns: {
        author: "作者",
        reviewer: "审阅者",
        package: "所属包",
        state: "状态",
        sort: "排序",
        all: "全部",
        me: "@me",
        states: {
          wip: "WIP",
          ready: "就绪",
          queued: "队列中",
          conflicts: "冲突",
          merged: "已合并",
          closed: "已关闭"
        },
        sorts: {
          "updated-desc": "最近更新",
          "updated-asc": "最久未更新",
          "created-desc": "最新创建",
          "created-asc": "最早创建",
          "priority-desc": "优先级"
        }
      },
      newDialog: {
        title: "新建变更列表",
        titleLabel: "标题",
        titlePlaceholder: "这个 CL 改了什么？",
        packageLabel: "所属包",
        branchLabel: "分支",
        branchPlaceholder: "feat/…",
        cancel: "取消",
        submit: "创建 CL",
        submitting: "创建中…",
        pushHint: "一次 push 可以携带多个提交——它们都属于同一个 CL。"
      }
    },
    clDetail: {
      notFoundTitle: "变更列表不存在",
      notFoundBody: "CL !{number} 不存在。",
      backToList: "返回变更列表",
      loading: "正在加载变更列表",
      error: "变更列表暂时不可用。",
      retry: "重试",
      chrome: {
        breadcrumbCls: "变更列表",
        states: {
          wip: "WIP",
          ready: "就绪",
          queued: "队列中",
          conflicts: "冲突",
          merged: "已合并",
          closed: "已关闭"
        },
        mergeSubject: "{author} 想把 {branch} 合入 {target}",
        revMeta: "rev {rev} / {total}",
        filesSummary: "{count} 个文件",
        rebase: "Rebase",
        merge: "合并",
        tabs: {
          conversation: "会话",
          revisions: "修订",
          files: "文件变更",
          checks: "检查",
          deps: "依赖"
        }
      },
      revisions: {
        loading: "正在加载修订",
        error: "修订暂时不可用。",
        retry: "重试",
        empty: "此 CL 还没有修订。",
        timelineAriaLabel: "修订时间线",
        baseMarkerAriaLabel: "分支基点",
        baseMarker: "{base} — 最初分支点",
        compareBar: {
          compare: "对比",
          fromAriaLabel: "对比起始修订",
          toAriaLabel: "对比目标修订",
          revChip: "rev {rev}",
          filesAcross: "{files} 个文件 · 跨 {revisions} 个修订",
          viewRangeDiff: "查看区间 diff"
        },
        card: {
          title: "Revision {rev}",
          current: "CURRENT",
          forcePush: "FORCE-PUSH",
          commits: "{count} 个提交",
          rebase: "rebase",
          upstreamCommits: "+ {count} 个上游提交",
          base: "base {base}",
          ci: "CI {status}",
          ciStatuses: {
            passing: "通过",
            failing: "失败",
            queued: "排队中",
            running: "运行中",
            skipped: "已跳过"
          },
          reviewed: "已审阅：",
          diffAgainst: "与 rev {rev} 对比"
        },
        clCommits: {
          title: "提交链",
          commits: "{count} 个提交",
          loading: "正在加载提交链",
          error: "提交链暂时不可用。",
          retry: "重试",
          empty: "此 CL 还没有提交。"
        },
        rangeSummary: {
          rangeTitle: "区间 diff 摘要",
          fetchTitle: "如何拉取",
          subscribeTitle: "订阅",
          subscribeAriaLabel: "订阅新修订",
          subscribeText: "新 revision 推送时通知 {me}、审阅者与负责人团队。"
        }
      },
      files: {
        loading: "正在加载变更文件",
        error: "变更文件暂时不可用。",
        retry: "重试",
        empty: "此 CL 没有变更文件。",
        invalidRange: "修订区间 \"{range}\" 无效——已显示完整 diff。",
        list: {
          filterAriaLabel: "过滤变更文件",
          filterPlaceholder: "过滤文件…",
          treeAriaLabel: "变更文件",
          viewedProgress: "{viewed}/{total} 已查看",
          files: "个文件",
          added: "新增",
          modified: "修改",
          deleted: "删除"
        },
        toolbar: {
          styleAriaLabel: "diff 样式",
          unified: "Unified",
          split: "Split",
          viewed: "已查看",
          rangeBadge: "rev {range}"
        }
      },
      inlineThreads: {
        addAriaLabel: "在此行添加评审评论",
        thread: {
          resolved: "RESOLVED",
          reply: "回复",
          quote: "引用",
          resolve: "标记已解决",
          unresolve: "取消已解决",
          replyAriaLabel: "回复此评审线程",
          cancelReplyAriaLabel: "取消回复",
          replyPlaceholder: "回复…",
          replySubmit: "回复",
          revStamp: "rev {rev}",
          quoteAttribution: "引用自 {author}"
        },
        draft: {
          inputAriaLabel: "在此行新建评审线程",
          placeholder: "在此行开启评审线程…",
          submit: "评论",
          cancel: "取消"
        }
      },
      checks: {
        loading: "正在加载检查",
        error: "检查暂时不可用。",
        retry: "重试",
        hero: {
          allPassed: "全部检查通过",
          inProgress: "检查进行中",
          someFailed: "部分检查失败",
          summary: "{total} 项检查中 {ok} 项成功 · {skipped} 项跳过 · 流水线耗时 {duration}",
          kvPipeline: "Pipeline",
          kvTrigger: "触发",
          kvRunner: "Runner",
          kvQueued: "入队",
          trigger: "push · rev {rev}",
          rerun: "全部重跑"
        },
        stageFlow: {
          title: "流水线",
          jobs: "{ok}/{total} 个任务",
          skipped: "已跳过"
        },
        table: {
          check: "检查",
          matrix: "矩阵",
          duration: "耗时",
          logs: "日志",
          passPill: "{count} 通过",
          statusAriaLabel: "状态：{status}"
        },
        benchPill: "{from} → {to}（{delta}）",
        tail: "Tail",
        downloadAriaLabel: "下载日志尾部",
        consoleAriaLabel: "{check} 的日志尾部",
        bench: {
          title: "基准变化",
          from: "基线 {value}"
        }
      },
      deps: {
        loading: "正在加载依赖",
        error: "依赖暂时不可用。",
        retry: "重试",
        graph: {
          title: "包依赖图",
          compileTime: "编译期",
          graphAriaLabel: "包依赖图",
          legendUpstream: "上游",
          legendThis: "本包",
          legendDownstream: "下游",
          columnUpstream: "上游（先构建）",
          columnThis: "本 CL",
          columnDownstream: "下游（将重建）",
          rebuilt: "合并后重建 {count} 个包",
          hotConsumer: "{count} 个热点消费者（{name}）",
          ciTime: "预计 CI 耗时 {duration}"
        },
        api: {
          title: "公共 API 变更",
          nonBreaking: "NON-BREAKING",
          tool: "cargo public-api"
        },
        related: {
          title: "相关 CL",
          relations: {
            blocks: "blocks",
            "depends-on": "depends on",
            supersedes: "supersedes",
            follows: "follows"
          }
        },
        issues: {
          title: "关联议题",
          closes: "CLOSES",
          none: "无"
        },
        symbols: {
          title: "符号反向引用",
          refs: "{refs} 处引用 · {files} 个文件",
          updated: "Codex 索引 · 更新于 {time}"
        }
      },
      conversation: {
        loading: "正在加载会话",
        error: "会话暂时不可用。",
        retry: "重试",
        viewed: "已查看",
        description: {
          badge: "DESCRIPTION",
          openedMeta: "创建了此 CL · {time}",
          closes: "Closes:",
          empty: "暂无描述。",
          edit: "编辑",
          finishEditing: "完成",
          saving: "保存中…",
          saved: "已保存",
          autoSaveHint: "2 秒后自动保存",
          placeholder: "描述此变更列表…",
          saveFailed: "保存失败 — 请重试"
        },
        thread: {
          commentedOn: "评论于 {file} {line} · {time}",
          resolved: "RESOLVED"
        },
        inlineSection: {
          title: "行内评论",
          empty: "暂无行内评论。",
          add: "添加行内评论",
          filePath: "文件路径",
          line: "行号",
          body: "评论",
          submit: "评论该行",
          submitting: "提交中…"
        },
        emptyPatch: "（空补丁）",
        mergeBox: {
          readyTitle: "可以合并",
          readySubtitle: "{approvals} 个批准 · merge score {score} · 与 main 无冲突",
          needsReviewTitle: "需要 review",
          needsReviewSubtitle: "{approvals}/{total} 个批准",
          inQueueTitle: "已在合并队列",
          inQueueSubtitle: "队列位置 {position}",
          rebaseTitle: "需要 rebase",
          rebaseSubtitle: "此 CL 与 main 存在冲突。",
          merged: "已合并",
          mergeAction: "合并 CL",
          rebaseAction: "Rebase",
          squashNote: "合并此 CL 只会在 main 上产生一个新提交。"
        },
        composer: {
          write: "撰写",
          preview: "预览",
          placeholder: "@mention · #issue · !CL · [[page]]…",
          previewEmpty: "暂无可预览内容。",
          submit: "评论",
          submitting: "评论中…",
          close: "关闭",
          closing: "关闭中…",
          cmdEnterHint: "⌘/Ctrl+Enter 发送评论"
        },
        sidebar: {
          reviewers: "审阅者",
          owners: "负责人（自动）",
          package: "所属包",
          linkedIssues: "关联议题",
          checks: "检查",
          revisions: "修订",
          closesOnMerge: "合并后关闭",
          none: "无",
          backlinks: {
            title: "反向链接",
            empty: "还没有内容链接到此变更。",
            unlinkedTitle: "未链接提及",
            unlinkedEmpty: "没有未链接提及。",
            convertLink: "转为链接",
            converting: "转换中…",
            typeDoc: "文档",
            typeIssue: "议题",
            typeCl: "变更",
            typeOther: "引用",
            blockContext: "被引用块：{summary}"
          },
          verdicts: {
            approved: "已批准",
            commented: "已评论",
            requested: "待审阅",
            pending: "待处理"
          }
        }
      }
    },
    issues: {
      title: "Issues",
      scopeAllPackages: "全部 package",
      labelsChip: "Labels · {count}",
      milestonesChip: "Milestones · {count}",
      newIssue: "New issue",
      filterAriaLabel: "过滤议题",
      filterPlaceholder: "is:open priority:P0..P2 pkg:git-internal…",
      openTab: "Open",
      closedTab: "Closed",
      loading: "正在加载议题",
      error: "议题暂时不可用。",
      retry: "重试",
      empty: "没有符合过滤条件的议题。",
      countsError: "计数暂时不可用。",
      row: {
        openedBy: "opened {time} · {author}",
        unassigned: "未分配",
        assigneesAriaLabel: "指派人",
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
        all: "全部",
        me: "@me",
        sorts: {
          "updated-desc": "最近更新",
          "updated-asc": "最久未更新",
          "created-desc": "最新创建",
          "created-asc": "最早创建",
          "priority-desc": "优先级"
        }
      },
      newDialog: {
        title: "新建议题",
        titleLabel: "标题",
        titlePlaceholder: "描述问题…",
        descriptionLabel: "描述（可选）",
        descriptionPlaceholder: "补充背景、预期行为或复现步骤…",
        packageLabel: "Package",
        priorityLabel: "优先级",
        cancel: "取消",
        submit: "创建议题",
        submitting: "创建中…"
      },
      detail: {
        notFoundTitle: "议题不存在",
        notFoundBody: "议题 #{number} 不存在。",
        backToList: "返回议题列表",
        body: {
          title: "描述",
          edit: "编辑",
          finishEditing: "完成",
          saving: "保存中…",
          saved: "已保存",
          autoSaveHint: "2 秒后自动保存",
          empty: "暂无描述。",
          placeholder: "描述此议题…",
          saveFailed: "保存失败 — 请重试"
        },
        header: {
          breadcrumbIssues: "Issues",
          openPill: "Open",
          closedPill: "Closed",
          meta: "{author} 创建于 {time} · {comments} 条评论 · pkg{package}",
          watching: "关注中",
          watch: "关注"
        },
        timeline: {
          addReaction: "添加回应",
          authorRole: "Author",
          assigneeRole: "Assignee"
        },
        composer: {
          write: "撰写",
          preview: "预览",
          placeholder: "@mention · #issue · !CL · [[page]]…",
          previewEmpty: "暂无可预览内容。",
          submit: "评论",
          submitting: "评论中…",
          close: "关闭议题",
          closing: "关闭中…",
          reopen: "重新打开议题",
          reopening: "重新打开中…",
          cmdEnterHint: "⌘/Ctrl+Enter 发送评论"
        },
        toasts: {
          closed: "议题已关闭。",
          reopened: "议题已重新打开。",
          watchOn: "已关注此议题。",
          watchOff: "已取消关注此议题。",
          commentAdded: "评论已添加。",
          actionFailed: "操作失败。"
        },
        sidebar: {
          assignees: "指派人",
          labels: "标签",
          package: "Package",
          milestone: "里程碑",
          linkedCls: "关联变更列表",
          participants: "参与者",
          progress: "完成 {percent}%",
          none: "无",
          backlinks: {
            title: "反向链接",
            empty: "还没有内容链接到此议题。",
            unlinkedTitle: "未链接提及",
            unlinkedEmpty: "没有未链接提及。",
            convertLink: "转为链接",
            converting: "转换中…",
            typeDoc: "文档",
            typeIssue: "议题",
            typeCl: "变更",
            typeOther: "引用",
            blockContext: "被引用块：{summary}"
          }
        }
      }
    }
  },
  validators: {
    user: {
      name: {
        minLength: "姓名至少需要{min}个字符",
        maxLength: "姓名不能超过{max}个字符"
      },
      email: {
        invalid: "请输入有效的邮箱地址"
      },
      username: {
        invalid: "用户名须为 2–31 位小写字母、数字或连字符"
      },
      image: {
        invalidUrl: "请输入有效的链接地址"
      },
      password: {
        minLength: "密码至少需要{min}个字符",
        maxLength: "密码不能超过{max}个字符",
        mismatch: "两次输入的密码不一致"
      },
      countryCode: {
        required: "请选择国家/地区"
      },
      phoneNumber: {
        required: "请输入手机号",
        invalid: "手机号格式不正确"
      },
      verificationCode: {
        invalidLength: "验证码必须是{length}位数字"
      },
      id: {
        required: "用户ID不能为空"
      },
      currentPassword: {
        required: "请输入当前密码"
      },
      confirmPassword: {
        required: "请确认密码"
      },
      deleteAccount: {
        confirmRequired: "您必须确认删除账户"
      }
    },
    userImage: {
      USER_IMAGE_INVALID_SCHEME: "头像必须是 HTTP(S) 链接，不能是内嵌数据",
      USER_IMAGE_INVALID_URL: "头像链接不在允许的存储来源范围内"
    }
  },
  countries: {
    china: "中国",
    usa: "美国",
    uk: "英国",
    japan: "日本",
    korea: "韩国",
    singapore: "新加坡",
    hongkong: "香港",
    macau: "澳门",
    australia: "澳大利亚",
    france: "法国",
    germany: "德国",
    india: "印度",
    malaysia: "马来西亚",
    thailand: "泰国"
  },
  header: {
    auth: {
      signIn: "登录",
      getStarted: "开始使用",
      signOut: "退出登录"
    },
    userMenu: {
      dashboard: "控制台",
      workspace: "工作台",
      profile: "个人资料",
      settings: "设置",
      personalSettings: "个人设置"
    },
    language: {
      switchLanguage: "切换语言",
      english: "English",
      chinese: "中文"
    },
    mobile: {
      themeSettings: "主题设置",
      languageSelection: "语言选择"
    }
  },
  upload: {
    title: "上传文件",
    description: "上传图片到云存储",
    providerTitle: "存储服务商",
    providerDescription: "选择您偏好的 S3 兼容存储服务商",
    providers: {
      s3: "Amazon S3",
      s3Description: "全球云存储",
      r2: "Cloudflare R2",
      r2Description: "零出口费用"
    },
    uploadTitle: "上传图片",
    uploadDescription: "将图片拖到此处，或点击选择文件。上限 1MB。",
    dragDrop: "拖拽文件到这里",
    orClick: "或点击浏览（最大 1MB）",
    browseFiles: "浏览文件",
    clearAll: "清除全部",
    uploadedTitle: "已上传文件",
    uploadedDescription: "已上传 {count} 个文件",
    uploading: "上传中...",
    viewFile: "查看",
    uploaded: "已上传",
    errors: {
      maxFiles: "只能上传 1 个文件",
      imageOnly: "只允许上传图片文件",
      fileTooLarge: "文件大小必须小于 1MB"
    },
    apiErrors: {
      UPLOAD_NO_FILE: "未提供文件",
      UPLOAD_FILE_TOO_LARGE: "文件大小超过 {maxMb}MB 上限",
      UPLOAD_INVALID_TYPE_AVATAR: "文件类型无效，头像仅支持图片文件。",
      UPLOAD_INVALID_TYPE_GENERAL: "文件类型无效，仅支持图片（JPEG、PNG、GIF、WebP、SVG、BMP）。",
      UPLOAD_INVALID_EXTENSION: "文件扩展名无效",
      UPLOAD_FAILED: "文件上传失败"
    }
  },
  errors: {
    search: {
      cjkScaleExceeded: "由于工作区规模过大，当前暂不支持该中文/CJK 搜索模式。请尝试英文查询，或缩小搜索范围。"
    },
    auth: {
      unauthorized: "需要登录",
    },
    mega: {
      badRequest: "请求无效。",
      notFound: "未找到资源。",
      forbidden: "您没有权限执行此操作。",
      conflict: "该资源已在其他位置被更新，请刷新后重试。",
      titleConflict: "已存在同标题的文档。",
      internal: "无法处理请求。",
    },
  },
  // WA-01 homepage (ADR-ARCH-09) — megaui-only; not ported from upstream SaaS `home`.
  home: {
    login: "登录",
    enterWorkspace: "进入 Workspace",
    metadata: {
      title: "Mega",
      description: "登录或进入你的 Mega 工作台。",
    },
  },
} satisfies Locale
