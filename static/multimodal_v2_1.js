(() => {
    const api = window.dentalMultiPatientV2;
    if (!api) {
        console.error("Dental multi-patient workspace API is unavailable.");
        return;
    }

    const SECTIONS = [
        "主诉", "现病史", "既往史", "口腔专科检查",
        "辅助检查", "诊断", "治疗计划", "处置", "医嘱", "待归类"
    ];
    const MAX_ANALYSIS_IMAGES = 6;
    const MAX_IMAGE_SIZE = 16 * 1024 * 1024;
    const IMAGE_TYPES = new Set([
        "image/jpeg", "image/png", "image/webp", "image/bmp"
    ]);

    function activeWorkspace() {
        return api.getActiveWorkspace();
    }

    function isActive(workspace) {
        return api.isActiveWorkspace(workspace);
    }

    function ensureState(workspace) {
        if (!workspace) return null;
        if (!Array.isArray(workspace.images)) workspace.images = [];
        if (!(workspace.selectedChatImageIds instanceof Set)) {
            workspace.selectedChatImageIds = new Set(
                workspace.selectedChatImageIds || []
            );
        }
        if (!Array.isArray(workspace.imageUploadDrafts)) {
            workspace.imageUploadDrafts = [];
        }
        if (typeof workspace.imagesLoaded !== "boolean") {
            workspace.imagesLoaded = false;
        }
        if (typeof workspace.imageUploadCount !== "number") {
            workspace.imageUploadCount = 0;
        }
        if (!workspace.imageUploadPromise) {
            workspace.imageUploadPromise = Promise.resolve();
        }
        if (typeof workspace.visionRunning !== "boolean") {
            workspace.visionRunning = false;
        }
        if (typeof workspace.visionPending !== "boolean") {
            workspace.visionPending = false;
        }
        if (typeof workspace.skipVisionOnce !== "boolean") {
            workspace.skipVisionOnce = false;
        }
        return workspace;
    }

    function shouldUseVision(workspace) {
        workspace = ensureState(workspace);
        return Boolean(
            workspace &&
            !workspace.skipVisionOnce &&
            (workspace.images.length > 0 || workspace.imageUploadCount > 0)
        );
    }

    async function loadImages(workspace, force = false) {
        workspace = ensureState(workspace);
        if (!workspace) return [];
        if (workspace.imagesLoaded && !force) return workspace.images;

        const visitId = workspace.visitId || await api.ensureVisit(workspace);
        if (!visitId) return [];

        try {
            const response = await fetch(
                `${API_BASE}/api/images?patient_id=${workspace.patient.id}&visit_id=${visitId}`
            );
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.detail || `读取图片失败（HTTP ${response.status}）`);
            }

            workspace.images = Array.isArray(data.images) ? data.images : [];
            workspace.imagesLoaded = true;
            const validIds = new Set(workspace.images.map(image => Number(image.id)));
            workspace.selectedChatImageIds = new Set(
                [...workspace.selectedChatImageIds]
                    .filter(imageId => validIds.has(Number(imageId)))
            );

            if (isActive(workspace)) refreshImageUi(workspace);
            return workspace.images;
        } catch (error) {
            api.workspaceLog(workspace, "读取病例图片失败：" + error.message);
            return workspace.images;
        }
    }

    function imageNumber(workspace, imageId) {
        const index = workspace.images.findIndex(
            image => Number(image.id) === Number(imageId)
        );
        return index >= 0 ? index + 1 : "?";
    }

    function stageDraft(workspace, file) {
        const previewUrl = URL.createObjectURL(file);
        const draft = {
            id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            file,
            previewUrl,
            status: "uploading",
            error: ""
        };
        workspace.imageUploadDrafts.push(draft);
        return draft;
    }

    function validateImageFile(file) {
        if (!file) throw new Error("图片文件无效");
        const suffix = file.name.includes(".")
            ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
            : "";
        const validSuffixes = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
        if (
            !IMAGE_TYPES.has((file.type || "").toLowerCase()) &&
            !validSuffixes.includes(suffix)
        ) {
            throw new Error(`${file.name || "图片"} 不是支持的图片格式`);
        }
        if (file.size <= 0) throw new Error(`${file.name || "图片"} 为空`);
        if (file.size > MAX_IMAGE_SIZE) {
            throw new Error(`${file.name || "图片"} 超过 16 MB`);
        }
    }

    async function uploadCaseImageFiles(
        files,
        workspace = activeWorkspace(),
        options = {}
    ) {
        workspace = ensureState(workspace);
        if (!workspace) {
            alert("请先选择患者");
            return [];
        }

        const selected = [...files];
        if (!selected.length) return [];

        for (const file of selected) validateImageFile(file);

        const visitId = workspace.visitId || await api.ensureVisit(workspace);
        if (!visitId) return [];

        const drafts = selected.map(file => stageDraft(workspace, file));
        workspace.imageUploadCount += selected.length;
        renderImageStaging(workspace);
        api.updateControls();

        const targetSection = options.section || "待归类";
        const task = api.makeTask(
            workspace,
            "病例图片",
            targetSection === "待归类"
                ? `上传 ${selected.length} 张病例图片`
                : `上传 ${selected.length} 张图片到“${targetSection}”`
        );

        const uploadPromise = (async () => {
            try {
                const formData = new FormData();
                formData.append("patient_id", String(workspace.patient.id));
                formData.append("visit_id", String(visitId));
                formData.append("section", options.section || "待归类");
                selected.forEach(file => formData.append("images", file, file.name));

                api.updateTask(workspace, task, "正在本机压缩并保存图片");
                const response = await fetch(`${API_BASE}/api/images/upload`, {
                    method: "POST",
                    body: formData
                });

                let data = {};
                try { data = await response.json(); } catch (_) {}
                if (!response.ok || !Array.isArray(data.images)) {
                    throw new Error(
                        data.detail || `图片上传失败（HTTP ${response.status}）`
                    );
                }

                const existing = new Map(
                    workspace.images.map(image => [Number(image.id), image])
                );
                data.images.forEach(image => existing.set(Number(image.id), image));
                workspace.images = [...existing.values()]
                    .sort((a, b) =>
                        Number(a.sort_order || a.id) - Number(b.sort_order || b.id)
                    );
                workspace.imagesLoaded = true;

                drafts.forEach(draft => {
                    draft.status = "done";
                    URL.revokeObjectURL(draft.previewUrl);
                });
                workspace.imageUploadDrafts = workspace.imageUploadDrafts
                    .filter(draft => !drafts.includes(draft));

                api.completeTask(
                    workspace,
                    task,
                    `${data.images.length} 张图片已绑定当前患者`
                );
                api.workspaceLog(
                    workspace,
                    `已上传 ${data.images.length} 张病例图片`
                );

                if (isActive(workspace)) refreshImageUi(workspace);
                return data.images;
            } catch (error) {
                drafts.forEach(draft => {
                    draft.status = "failed";
                    draft.error = error.message;
                });
                api.failTask(workspace, task, error.message);
                api.workspaceLog(workspace, "图片上传失败：" + error.message);
                if (isActive(workspace)) {
                    renderImageStaging(workspace);
                    alert("图片上传失败：" + error.message);
                }
                return [];
            } finally {
                workspace.imageUploadCount = Math.max(
                    0,
                    workspace.imageUploadCount - selected.length
                );
                api.updateControls();
                api.refreshTasks(workspace);
            }
        })();

        workspace.imageUploadPromise = Promise.allSettled([
            workspace.imageUploadPromise,
            uploadPromise
        ]);
        return await uploadPromise;
    }

    function renderImageStaging(workspace = activeWorkspace()) {
        const container = document.getElementById("case-image-staging");
        if (!container) return;
        workspace = ensureState(workspace);

        const drafts = workspace?.imageUploadDrafts || [];
        const images = workspace?.images || [];

        if (!drafts.length && !images.length) {
            container.classList.add("hidden");
            container.innerHTML = "";
            return;
        }

        container.classList.remove("hidden");
        container.innerHTML = `
            <div class="image-upload-summary">
                <div>
                    <p class="text-xs font-semibold text-slate-700">
                        已上传病例图片 ${images.length} 张
                    </p>
                    <p class="text-[10px] text-slate-400 mt-0.5">
                        图片会显示归档位置；待归类图片可通过“智能归档”自动分配
                    </p>
                </div>
                <button type="button" onclick="openCaseImageLibrary()"
                    class="text-[11px] px-2 py-1 rounded-md border border-blue-200 text-blue-600 bg-white hover:bg-blue-50">
                    管理全部
                </button>
            </div>

            <div class="image-upload-gallery">
                ${drafts.map((draft, index) => `
                    <div class="image-upload-card is-uploading">
                        <div class="image-upload-preview">
                            <img src="${draft.previewUrl}" alt="待上传图片">
                            <span class="image-number-badge">新图片${index + 1}</span>
                        </div>
                        <p class="image-upload-title">
                            ${draft.status === "failed" ? "上传失败" : "正在上传"}
                        </p>
                        <p class="image-upload-meta ${
                            draft.status === "failed" ? "text-red-500" : ""
                        }">
                            ${draft.status === "failed" ? api.escapeHtml(draft.error) : "本机压缩保存中…"}
                        </p>
                    </div>
                `).join("")}

                ${images.map(image => {
                    const section = image.section || "待归类";
                    const pending = section === "待归类";
                    return `
                        <div class="image-upload-card">
                            <div class="image-upload-preview"
                                onclick="openCaseImageLightbox(${Number(image.id)})">
                                <img src="${image.thumbnail_url}"
                                    alt="${api.escapeHtml(image.caption || image.filename || "病例图片")}">
                                <span class="image-number-badge">
                                    图片${imageNumber(workspace, image.id)}
                                </span>
                                <button type="button"
                                    class="image-direct-delete"
                                    title="删除图片"
                                    onclick="event.stopPropagation(); deleteCaseImage(${Number(image.id)})">
                                    ×
                                </button>
                            </div>
                            <p class="image-upload-title">
                                ${api.escapeHtml(image.caption || image.filename || "病例图片")}
                            </p>
                            <div class="image-upload-location ${pending ? "is-pending" : ""}">
                                ${pending ? "待归类" : "已归入：" + api.escapeHtml(section)}
                            </div>
                            <button type="button"
                                onclick="deleteCaseImage(${Number(image.id)})"
                                class="image-delete-text">
                                删除这张图片
                            </button>
                        </div>
                    `;
                }).join("")}
            </div>
        `;
    }

    async function handleImageFiles(files) {
        const workspace = activeWorkspace();
        if (!workspace) {
            alert("请先选择患者");
            return;
        }
        try {
            const selected = [...(files || [])];
            if (!selected.length) return;
            const status = document.getElementById("text-import-status");
            if (status) status.textContent = `正在上传 ${selected.length} 张图片…`;
            const uploaded = await uploadCaseImageFiles(selected, workspace);
            if (status) {
                status.textContent = uploaded.length
                    ? `已成功上传 ${uploaded.length} 张图片，可继续填写描述或智能归档`
                    : "图片未上传成功，请查看页面提示";
            }
        } catch (error) {
            const status = document.getElementById("text-import-status");
            if (status) status.textContent = "图片上传失败：" + error.message;
            alert("图片上传失败：" + error.message);
        }
    }

    window.handleCaseImageSelect = async event => {
        // FileList 会随着 input.value 清空而失效，必须先复制成普通数组。
        const files = [...(event.target.files || [])];
        event.target.value = "";
        await handleImageFiles(files);
    };

    window.handleCaseImageDrag = (event, active) => {
        event.preventDefault();
        event.stopPropagation();
        const zone = document.getElementById("case-image-drop-zone");
        if (zone) zone.classList.toggle("drop-zone-active", Boolean(active));
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };

    window.handleCaseImageDrop = async event => {
        event.preventDefault();
        event.stopPropagation();
        const zone = document.getElementById("case-image-drop-zone");
        if (zone) zone.classList.remove("drop-zone-active");
        const files = [...(event.dataTransfer?.files || [])]
            .filter(file => (file.type || "").startsWith("image/") ||
                /\.(jpe?g|png|webp|bmp)$/i.test(file.name || ""));
        if (!files.length) {
            alert("拖入的文件中没有支持的图片");
            return;
        }
        await handleImageFiles(files);
    };

    window.pasteCaseMaterialFromClipboard = async () => {
        const workspace = activeWorkspace();
        if (!workspace) {
            alert("请先选择患者");
            return;
        }

        const textarea = document.getElementById("transcript-text-input");
        let foundAnything = false;

        try {
            if (navigator.clipboard?.read) {
                const items = await navigator.clipboard.read();
                const imageFiles = [];

                for (const item of items) {
                    for (const type of item.types) {
                        if (type.startsWith("image/")) {
                            const blob = await item.getType(type);
                            const extension =
                                type === "image/png" ? "png" : "jpg";
                            imageFiles.push(
                                new File(
                                    [blob],
                                    `clipboard-${Date.now()}-${imageFiles.length + 1}.${extension}`,
                                    {type}
                                )
                            );
                            foundAnything = true;
                        } else if (type === "text/plain") {
                            const blob = await item.getType(type);
                            const text = await blob.text();
                            if (text.trim()) {
                                textarea.value = [
                                    textarea.value.trim(),
                                    text.trim()
                                ].filter(Boolean).join("\n");
                                workspace.textDraft = textarea.value;
                                foundAnything = true;
                            }
                        }
                    }
                }

                if (imageFiles.length) {
                    await uploadCaseImageFiles(imageFiles, workspace);
                }
            }

            if (!foundAnything && navigator.clipboard?.readText) {
                const text = await navigator.clipboard.readText();
                if (text.trim()) {
                    textarea.value = [
                        textarea.value.trim(),
                        text.trim()
                    ].filter(Boolean).join("\n");
                    workspace.textDraft = textarea.value;
                    foundAnything = true;
                }
            }

            if (!foundAnything) {
                throw new Error("剪贴板中没有可读取的文字或图片");
            }

            document.getElementById("text-import-status").textContent =
                "已粘贴病例资料；图片已上传，填写描述后点击“智能归档”";
            textarea.focus();
        } catch (error) {
            textarea.focus();
            document.getElementById("text-import-status").textContent =
                "请在描述框按 Ctrl+V 粘贴文字或截图";
        }
    };

    async function handleTextareaPaste(event) {
        const workspace = activeWorkspace();
        if (!workspace) return;

        const imageFiles = [];
        const items = [...(event.clipboardData?.items || [])];

        for (const item of items) {
            if (item.type.startsWith("image/")) {
                const blob = item.getAsFile();
                if (!blob) continue;
                const extension =
                    item.type === "image/png" ? "png" : "jpg";
                imageFiles.push(
                    new File(
                        [blob],
                        `pasted-${Date.now()}-${imageFiles.length + 1}.${extension}`,
                        {type: item.type}
                    )
                );
            }
        }

        if (imageFiles.length) {
            await uploadCaseImageFiles(imageFiles, workspace);
            document.getElementById("text-import-status").textContent =
                `已粘贴并上传 ${imageFiles.length} 张图片，可继续填写医生描述`;
        }
    }

    function mergeRecordPreservingManual(workspace, generated) {
        const merged = {...generated};
        workspace.manualSections.forEach(section => {
            if (workspace.record?.[section]) {
                merged[section] = {
                    ...workspace.record[section],
                    source: "manual",
                    needs_confirm: false
                };
            }
        });
        return merged;
    }

    async function analyzeWorkspace(workspace, options = {}) {
        workspace = ensureState(workspace);
        if (!workspace) return;

        await workspace.imageUploadPromise;
        await loadImages(workspace);

        const preferredIds = Array.isArray(options.imageIds)
            ? options.imageIds.map(Number)
            : [];
        const availableIds = workspace.images.map(image => Number(image.id));
        const imageIds = [...new Set(
            preferredIds.length ? preferredIds : availableIds
        )].slice(0, MAX_ANALYSIS_IMAGES);

        if (!imageIds.length) {
            workspace.skipVisionOnce = true;
            try {
                return await api.generateTextRecord(
                    workspace,
                    Boolean(options.automatic)
                );
            } finally {
                workspace.skipVisionOnce = false;
            }
        }

        if (workspace.visionRunning || workspace.generationRunning) {
            workspace.visionPending = true;
            workspace.status.autoFill =
                "已收到新的图文资料，当前分析完成后会自动再次整理";
            if (isActive(workspace)) {
                document.getElementById("auto-fill-status").textContent =
                    workspace.status.autoFill;
            }
            return;
        }

        const visitId = workspace.visitId || await api.ensureVisit(workspace);
        if (!visitId) return;

        if (isActive(workspace)) {
            try {
                workspace.record = collectTemplateSections();
            } catch (_) {}
        }

        workspace.visionRunning = true;
        workspace.generationRunning = true;
        workspace.generationManual = !options.automatic;
        workspace.status.autoFill = options.automatic
            ? "本地多模态模型正在后台整合录音、描述和图片"
            : "本地多模态模型正在分析病例图片与医生描述";

        const task = api.makeTask(
            workspace,
            "多模态分析",
            `整合 ${imageIds.length} 张图片与病例文字`
        );
        api.updateTask(workspace, task, "正在调用本地视觉模型");

        if (isActive(workspace)) {
            api.syncGlobals(workspace);
            const status = document.getElementById("auto-fill-status");
            status.textContent = workspace.status.autoFill;
            status.className =
                "text-xs text-center text-purple-600 mb-2 auto-fill-running";
            if (!options.automatic) {
                document.getElementById("loading-text").textContent =
                    "AI正在理解病例图片、医生描述与录音内容…";
                document.getElementById("loading-overlay")
                    .classList.remove("hidden");
            }
            api.updateControls();
        }

        try {
            const response = await fetch(
                `${API_BASE}/api/multimodal/analyze`,
                {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({
                        patient_id: workspace.patient.id,
                        visit_id: visitId,
                        description: options.description || "",
                        conversation: workspace.conversation.map(item => ({...item})),
                        record: workspace.record || {},
                        image_ids: imageIds
                    })
                }
            );

            let data = {};
            try { data = await response.json(); } catch (_) {}
            if (!response.ok || !data.record) {
                throw new Error(
                    data.detail || `多模态分析失败（HTTP ${response.status}）`
                );
            }

            workspace.record = mergeRecordPreservingManual(
                workspace,
                data.record
            );
            workspace.images = Array.isArray(data.images)
                ? data.images
                : workspace.images;
            workspace.imagesLoaded = true;
            workspace.visionSummary = data.summary || "";
            workspace.status.autoFill =
                "图文智能归档完成，请医生审核图片观察和诊断建议";

            api.completeTask(workspace, task, "图文已归档到病历版块");
            api.workspaceLog(
                workspace,
                `完成多模态病例分析：${imageIds.length} 张图片`
            );

            if (isActive(workspace)) {
                api.syncGlobals(workspace);
                renderRecordEditor(workspace.record);
                refreshImageUi(workspace);
                const status = document.getElementById("auto-fill-status");
                status.textContent = workspace.status.autoFill;
                status.className =
                    "text-xs text-center text-green-600 mb-2";
                document.getElementById("btn-save").disabled = false;
                document.getElementById("btn-export").disabled = false;
            }
        } catch (error) {
            workspace.status.autoFill =
                "图文分析失败：" + error.message;
            api.failTask(workspace, task, error.message);
            api.workspaceLog(
                workspace,
                "多模态病例分析失败：" + error.message
            );

            if (isActive(workspace)) {
                const status = document.getElementById("auto-fill-status");
                status.textContent = workspace.status.autoFill;
                status.className =
                    "text-xs text-center text-red-600 mb-2";
                if (!options.automatic) alert(error.message);
            }
        } finally {
            workspace.visionRunning = false;
            workspace.generationRunning = false;
            workspace.generationManual = false;

            if (isActive(workspace)) {
                api.syncGlobals(workspace);
                document.getElementById("loading-overlay")
                    .classList.add("hidden");
                api.updateControls();
            }
            api.refreshTasks(workspace);

            if (workspace.visionPending) {
                workspace.visionPending = false;
                setTimeout(
                    () => analyzeWorkspace(workspace, {
                        automatic: true,
                        source: "queued-update"
                    }),
                    180
                );
            }
        }
    }

    window.importPastedTranscript = async () => {
        const workspace = ensureState(activeWorkspace());
        if (!workspace) {
            alert("请先选择患者");
            return;
        }

        const textarea = document.getElementById("transcript-text-input");
        const description = textarea.value.trim();
        const hasImages =
            workspace.images.length > 0 ||
            workspace.imageUploadCount > 0;

        if (!description && !hasImages) {
            alert("请输入医生描述、粘贴转写文字，或先上传病例图片");
            textarea.focus();
            return;
        }

        const visitId = workspace.visitId || await api.ensureVisit(workspace);
        if (!visitId) return;

        await workspace.imageUploadPromise;
        await loadImages(workspace);

        if (description) {
            const selectedType =
                document.getElementById("text-import-speaker").value;
            const speaker =
                selectedType === "doctor" ? "doctor" : selectedType;
            api.addConversation(
                workspace,
                speaker,
                description,
                {
                    source:
                        selectedType === "doctor"
                            ? "doctor_description"
                            : "text_paste",
                    filename:
                        selectedType === "doctor"
                            ? "医生描述"
                            : "粘贴文字",
                    format: "文字",
                    chars: description.length
                }
            );
            workspace.textDraft = "";
            textarea.value = "";
        }

        if (workspace.images.length) {
            await analyzeWorkspace(workspace, {
                automatic: false,
                description,
                imageIds: workspace.images
                    .slice(0, MAX_ANALYSIS_IMAGES)
                    .map(image => Number(image.id)),
                source: "doctor-material"
            });
        } else {
            workspace.skipVisionOnce = true;
            try {
                await api.generateTextRecord(workspace, false);
            } finally {
                workspace.skipVisionOnce = false;
            }
        }
    };

    // --------------------------------------------------------
    // Section image placement
    // --------------------------------------------------------
    const originalRenderRecordEditor = window.renderRecordEditor;
    window.renderRecordEditor = function(record) {
        originalRenderRecordEditor(record);
        setTimeout(() => renderSectionImages(activeWorkspace()), 0);
    };

    function renderSectionImages(workspace = activeWorkspace()) {
        workspace = ensureState(workspace);
        if (!workspace) return;

        document.querySelectorAll(".section-image-strip")
            .forEach(node => node.remove());

        for (const section of SECTIONS.filter(item => item !== "待归类")) {
            const images = workspace.images.filter(
                image => (image.section || "待归类") === section
            );
            if (!images.length) continue;

            const card = document.getElementById(`template-section-${section}`);
            if (!card) continue;

            const strip = document.createElement("div");
            strip.className = "section-image-strip";
            strip.innerHTML = `
                <div class="flex items-center justify-between mb-2">
                    <span class="text-[11px] font-medium text-blue-700">
                        关联病例图片 ${images.length}
                    </span>
                    <button class="text-[11px] text-gray-400 hover:text-blue-600"
                        onclick="openCaseImageLibrary()">管理</button>
                </div>
                <div class="case-image-row">
                    ${images.map(image => `
                        <div class="case-image-thumb">
                            <div class="relative cursor-pointer"
                                onclick="openCaseImageLightbox(${Number(image.id)})">
                                <img src="${image.thumbnail_url}" alt="${api.escapeHtml(image.caption || image.filename || "病例图片")}">
                                <button type="button"
                                    class="section-image-delete"
                                    title="从病例中删除图片"
                                    onclick="event.stopPropagation(); deleteCaseImage(${Number(image.id)})">
                                    ×
                                </button>
                            </div>
                            <p class="text-[10px] text-gray-600 mt-1 truncate">
                                图片${imageNumber(workspace, image.id)}
                                ${image.tooth_position ? " · " + api.escapeHtml(image.tooth_position) : ""}
                            </p>
                            <p class="text-[10px] text-gray-400 truncate">
                                ${api.escapeHtml(image.caption || image.image_type || "待医生确认")}
                            </p>
                        </div>
                    `).join("")}
                </div>
            `;
            card.appendChild(strip);
        }
    }

    function refreshImageLibraryButton(workspace = activeWorkspace()) {
        const button =
            document.getElementById("case-image-library-button");
        if (!button) return;

        const count = workspace?.images?.length || 0;
        const unassigned = workspace?.images?.filter(
            image => (image.section || "待归类") === "待归类"
        ).length || 0;
        button.textContent =
            `病例图片 ${count}${unassigned ? ` · 待归类${unassigned}` : ""}`;
    }

    function renderImageLibrary(workspace = activeWorkspace()) {
        const grid =
            document.getElementById("case-image-library-grid");
        if (!grid) return;
        workspace = ensureState(workspace);

        if (!workspace?.images?.length) {
            grid.innerHTML = `
                <div class="col-span-3 text-center py-12 text-gray-400">
                    当前患者还没有病例图片
                </div>
            `;
            return;
        }

        grid.innerHTML = workspace.images.map(image => `
            <div class="border rounded-xl p-3 bg-gray-50">
                <div class="relative cursor-pointer"
                    onclick="openCaseImageLightbox(${Number(image.id)})">
                    <img src="${image.thumbnail_url}" alt="病例图片">
                    <span class="absolute left-2 top-2 px-2 py-0.5 rounded-full bg-black/60 text-white text-[10px]">
                        图片${imageNumber(workspace, image.id)}
                    </span>
                    ${
                        image.needs_confirm
                            ? '<span class="absolute right-2 top-2 px-2 py-0.5 rounded-full bg-red-500/90 text-white text-[10px]">需确认</span>'
                            : ""
                    }
                </div>
                <p class="text-xs text-gray-500 mt-2 truncate">
                    ${api.escapeHtml(image.filename || "病例图片")}
                </p>
                <select class="w-full mt-2 px-2 py-1.5 border rounded-lg text-xs bg-white"
                    onchange="updateCaseImageSection(${Number(image.id)}, this.value)">
                    ${SECTIONS.map(section => `
                        <option value="${section}" ${
                            (image.section || "待归类") === section
                                ? "selected"
                                : ""
                        }>${section}</option>
                    `).join("")}
                </select>
                <input value="${api.escapeHtml(image.caption || "")}"
                    placeholder="图片图注"
                    class="w-full mt-2 px-2 py-1.5 border rounded-lg text-xs"
                    onchange="updateCaseImageCaption(${Number(image.id)}, this.value)">
                <div class="flex items-center justify-between mt-2">
                    <span class="text-[10px] text-gray-400 truncate">
                        ${api.escapeHtml(image.image_type || "其他")}
                        ${image.tooth_position ? " · " + api.escapeHtml(image.tooth_position) : ""}
                    </span>
                    <button onclick="deleteCaseImage(${Number(image.id)})"
                        class="text-[11px] text-red-500 hover:text-red-700">删除</button>
                </div>
            </div>
        `).join("");
    }

    window.openCaseImageLibrary = async () => {
        const workspace = activeWorkspace();
        if (!workspace) {
            alert("请先选择患者");
            return;
        }
        await loadImages(workspace);
        renderImageLibrary(workspace);
        document.getElementById("case-image-modal")
            .classList.remove("hidden");
    };

    window.closeCaseImageLibrary = () => {
        document.getElementById("case-image-modal")
            .classList.add("hidden");
    };

    function findImage(imageId, workspace = activeWorkspace()) {
        return workspace?.images?.find(
            image => Number(image.id) === Number(imageId)
        );
    }

    window.openCaseImageLightbox = imageId => {
        const workspace = activeWorkspace();
        const image = findImage(imageId, workspace);
        if (!image) return;

        document.getElementById("case-image-lightbox-img").src =
            image.url;
        document.getElementById("case-image-lightbox-caption").textContent =
            `图片${imageNumber(workspace, image.id)} · ${
                image.caption ||
                image.observations ||
                image.filename ||
                "病例图片"
            }`;
        document.getElementById("case-image-lightbox")
            .classList.remove("hidden");
    };

    window.closeCaseImageLightbox = () => {
        document.getElementById("case-image-lightbox")
            .classList.add("hidden");
    };

    async function updateImageMetadata(imageId, changes) {
        const workspace = activeWorkspace();
        if (!workspace) return;

        try {
            const response = await fetch(
                `${API_BASE}/api/images/${imageId}`,
                {
                    method: "PUT",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify(changes)
                }
            );
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.detail || "更新图片信息失败");
            }

            workspace.images = workspace.images.map(image =>
                Number(image.id) === Number(imageId) ? data : image
            );
            refreshImageUi(workspace);
            renderImageLibrary(workspace);
        } catch (error) {
            alert(error.message);
        }
    }

    window.updateCaseImageSection = (imageId, section) =>
        updateImageMetadata(imageId, {section});

    window.updateCaseImageCaption = (imageId, caption) =>
        updateImageMetadata(imageId, {caption});

    window.deleteCaseImage = async imageId => {
        const workspace = activeWorkspace();
        if (!workspace) return;
        if (!confirm("确定删除这张病例图片吗？")) return;

        try {
            const response = await fetch(
                `${API_BASE}/api/images/${imageId}`,
                {method: "DELETE"}
            );
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.detail || "删除图片失败");
            }

            workspace.images = workspace.images.filter(
                image => Number(image.id) !== Number(imageId)
            );
            workspace.selectedChatImageIds.delete(Number(imageId));
            refreshImageUi(workspace);
            renderImageLibrary(workspace);
        } catch (error) {
            alert(error.message);
        }
    };

    // --------------------------------------------------------
    // Chat image selection and multimodal Q&A
    // --------------------------------------------------------
    function renderChatImageSelection(workspace = activeWorkspace()) {
        const button =
            document.getElementById("chat-image-picker-button");
        const selectedContainer =
            document.getElementById("chat-selected-images");
        const picker =
            document.getElementById("chat-image-picker");
        if (!button || !selectedContainer || !picker) return;

        workspace = ensureState(workspace);
        const images = workspace?.images || [];
        const selectedIds = workspace?.selectedChatImageIds || new Set();

        button.textContent = `选择病例图片 ${selectedIds.size}`;
        selectedContainer.classList.toggle(
            "hidden",
            selectedIds.size === 0
        );
        selectedContainer.innerHTML = images
            .filter(image => selectedIds.has(Number(image.id)))
            .map(image => `
                <button onclick="toggleChatImageSelection(${Number(image.id)})"
                    class="relative shrink-0">
                    <img src="${image.thumbnail_url}"
                        class="w-12 h-10 object-cover rounded-md image-selected-ring">
                    <span class="absolute -right-1 -top-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px]">×</span>
                </button>
            `).join("");

        picker.innerHTML = images.length
            ? images.map(image => {
                const selected = selectedIds.has(Number(image.id));
                return `
                    <button onclick="toggleChatImageSelection(${Number(image.id)})"
                        class="w-full flex items-center gap-2 p-2 rounded-lg text-left ${
                            selected ? "bg-purple-50" : "hover:bg-gray-50"
                        }">
                        <img src="${image.thumbnail_url}"
                            class="w-14 h-11 object-cover rounded-md ${
                                selected ? "image-selected-ring" : ""
                            }">
                        <div class="min-w-0 flex-1">
                            <p class="text-xs font-medium text-gray-700 truncate">
                                图片${imageNumber(workspace, image.id)}
                                · ${api.escapeHtml(image.section || "待归类")}
                            </p>
                            <p class="text-[10px] text-gray-400 truncate">
                                ${api.escapeHtml(image.caption || image.filename || "病例图片")}
                            </p>
                        </div>
                        <span class="text-xs ${
                            selected ? "text-purple-600" : "text-gray-300"
                        }">${selected ? "已选" : "选择"}</span>
                    </button>
                `;
            }).join("")
            : '<p class="text-xs text-gray-400 text-center py-4">当前病例暂无图片</p>';
    }

    window.toggleChatImagePicker = async () => {
        const workspace = activeWorkspace();
        if (!workspace) {
            alert("请先选择患者");
            return;
        }
        await loadImages(workspace);
        renderChatImageSelection(workspace);
        document.getElementById("chat-image-picker")
            .classList.toggle("hidden");
    };

    window.toggleChatImageSelection = imageId => {
        const workspace = ensureState(activeWorkspace());
        if (!workspace) return;

        imageId = Number(imageId);
        if (workspace.selectedChatImageIds.has(imageId)) {
            workspace.selectedChatImageIds.delete(imageId);
        } else {
            if (
                workspace.selectedChatImageIds.size >=
                MAX_ANALYSIS_IMAGES
            ) {
                alert(`一次最多选择 ${MAX_ANALYSIS_IMAGES} 张图片`);
                return;
            }
            workspace.selectedChatImageIds.add(imageId);
        }
        renderChatImageSelection(workspace);
    };

    window.analyzeSelectedCaseImages = () => {
        const workspace = ensureState(activeWorkspace());
        if (!workspace) {
            alert("请先选择患者");
            return;
        }
        if (!workspace.selectedChatImageIds.size) {
            alert("请先点击“选择病例图片”并勾选要分析的图片");
            return;
        }

        const input = document.getElementById("case-chat-input");
        if (!input.value.trim()) {
            input.value =
                "请对所选病例图片进行辅助分析：描述可见表现、可能的鉴别考虑、图像局限性，以及仍需补充的临床检查。";
        }
        sendCaseQuestion();
    };

    window.sendCaseQuestion = async () => {
        const workspace = ensureState(activeWorkspace());
        if (!workspace) {
            alert("请先选择患者");
            return;
        }
        if (workspace.chatRunning) return;

        const input = document.getElementById("case-chat-input");
        const question = input.value.trim();
        if (!question) return;

        const visitId = workspace.visitId || await api.ensureVisit(workspace);
        if (!visitId) return;

        if (isActive(workspace)) {
            try {
                workspace.record = collectTemplateSections();
            } catch (_) {}
        }

        const imageIds = [...workspace.selectedChatImageIds]
            .slice(0, MAX_ANALYSIS_IMAGES);
        const history = workspace.chatHistory
            .filter(item =>
                item.role === "user" || item.role === "assistant"
            )
            .slice(-8);
        const conversationSnapshot =
            workspace.conversation.map(item => ({...item}));
        const recordSnapshot = JSON.parse(
            JSON.stringify(workspace.record || emptyRecord())
        );

        workspace.chatDraft = "";
        input.value = "";
        workspace.chatHistory.push({
            role: "user",
            content:
                question +
                (imageIds.length
                    ? `\n\n【已选择 ${imageIds.length} 张病例图片】`
                    : "")
        });
        workspace.chatRunning = true;
        workspace.status.chat = imageIds.length
            ? "本地视觉模型正在分析所选病例图片，可切换其他患者"
            : "本地模型正在结合当前病例回答，可切换其他患者";

        const task = api.makeTask(
            workspace,
            imageIds.length ? "图像问答" : "病例问答",
            question.slice(0, 32) + (question.length > 32 ? "…" : "")
        );
        api.renderChat(workspace);
        api.updateControls();

        try {
            const response = await fetch(`${API_BASE}/api/chat`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    patient_id: workspace.patient.id,
                    visit_id: visitId,
                    question,
                    conversation: conversationSnapshot,
                    record: recordSnapshot,
                    history,
                    image_ids: imageIds
                })
            });

            let data = {};
            try { data = await response.json(); } catch (_) {}
            if (!response.ok || !data.answer) {
                throw new Error(
                    data.detail || `问答失败（HTTP ${response.status}）`
                );
            }

            const cleanAnswer = typeof normalizeCaseChatText === "function"
                ? normalizeCaseChatText(data.answer)
                : String(data.answer || "").replaceAll("*", "");
            workspace.chatHistory.push({
                role: "assistant",
                content: cleanAnswer
            });
            workspace.chatHistory = workspace.chatHistory.slice(-20);
            workspace.status.chat = imageIds.length
                ? `已结合 ${imageIds.length} 张图片回答，结果需医生确认`
                : `回答来自本机模型 ${data.local_model || ""}，请医生审核`;
            api.completeTask(workspace, task, "问答完成");
            api.workspaceLog(
                workspace,
                imageIds.length
                    ? "完成一次病例图片辅助问答"
                    : "完成一次本地病例问答"
            );
        } catch (error) {
            workspace.chatHistory.push({
                role: "assistant",
                content:
                    "问答失败：" +
                    error.message +
                    "\n请确认本地模型已通过 v2.1 启动器加载 mmproj。"
            });
            workspace.status.chat = "问答失败";
            api.failTask(workspace, task, error.message);
            api.workspaceLog(workspace, "病例问答失败：" + error.message);
        } finally {
            workspace.chatRunning = false;
            if (isActive(workspace)) {
                api.syncGlobals(workspace);
                api.renderChat(workspace);
                renderChatImageSelection(workspace);
                document.getElementById("case-chat-status").textContent =
                    workspace.status.chat;
                api.updateControls();
                input.focus();
            }
            api.refreshTasks(workspace);
        }
    };

    function refreshImageUi(workspace = activeWorkspace()) {
        if (!workspace || !isActive(workspace)) return;
        renderImageStaging(workspace);
        refreshImageLibraryButton(workspace);
        renderSectionImages(workspace);
        renderChatImageSelection(workspace);
    }

    function onWorkspaceRendered(workspace) {
        workspace = ensureState(workspace);
        if (!workspace) return;

        document.getElementById("text-import-speaker").value =
            workspace.textSpeaker || "doctor";
        renderImageStaging(workspace);
        refreshImageLibraryButton(workspace);
        renderSectionImages(workspace);
        renderChatImageSelection(workspace);

        if (!workspace.imagesLoaded) {
            api.ensureVisit(workspace).then(() =>
                loadImages(workspace).then(() => {
                    if (isActive(workspace)) refreshImageUi(workspace);
                })
            );
        }
    }

    function onWorkspaceDraftSaved(workspace) {
        workspace = ensureState(workspace);
        if (!workspace) return;
        workspace.textDraft =
            document.getElementById("transcript-text-input")?.value || "";
    }

    function onControlsUpdated(workspace) {
        const disabled = !workspace || isRecording;
        ["case-image-input", "btn-select-case-images"].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = disabled;
        });
    }

    window.dentalMultimodalV21 = {
        version: "2.3",
        shouldUseVision,
        analyzeWorkspace,
        uploadCaseImageFiles,
        loadImages,
        refreshImageUi,
        ensureState,
        onWorkspaceRendered,
        onWorkspaceDraftSaved,
        onControlsUpdated,
        hasImages: workspace =>
            Boolean(ensureState(workspace)?.images?.length)
    };

    document.getElementById("transcript-text-input")
        ?.addEventListener("paste", handleTextareaPaste);

    document.addEventListener("click", event => {
        const picker =
            document.getElementById("chat-image-picker");
        const button =
            document.getElementById("chat-image-picker-button");
        if (
            picker &&
            button &&
            !picker.classList.contains("hidden") &&
            !picker.contains(event.target) &&
            !button.contains(event.target)
        ) {
            picker.classList.add("hidden");
        }
    });
})();
