
(() => {
    const patientWorkspacesV2 = new Map();
    let activeWorkspaceV2 = null;
    let activeRecordingV2 = null;

    function newWorkspaceV2(patient) {
        return {
            patient: {...patient},
            visitId: null,
            visitPromise: null,
            conversation: [],
            record: emptyRecord(),
            manualSections: new Set(),
            extracted: {},
            chatHistory: [],
            chatRunning: false,
            chatDraft: "",
            generationRunning: false,
            generationPending: false,
            generationSequence: 0,
            generationManual: false,
            transcribeCount: 0,
            importCount: 0,
            tasks: new Map(),
            logs: [],
            textDraft: "",
            currentSpeaker: "mixed",
            uploadSpeaker: "mixed",
            textSpeaker: "mixed",
            lastAudioFile: "",
            status: {
                visit: "尚未创建就诊记录",
                visitState: "pending",
                record: "点击开始录音，系统会自动转写",
                upload: "上传文件将在本机完成转写",
                textImport: "导入后会加入对话，并按设置自动回填病历",
                autoFill: "等待录音、粘贴或文件导入",
                chat: "数据仅发送至本机部署模型"
            }
        };
    }

    function workspaceForV2(patient) {
        const id = Number(patient.id);
        let workspace = patientWorkspacesV2.get(id);
        if (!workspace) {
            workspace = newWorkspaceV2(patient);
            patientWorkspacesV2.set(id, workspace);
        } else {
            workspace.patient = {...workspace.patient, ...patient};
        }
        return workspace;
    }

    function isActiveV2(workspace) {
        return Boolean(
            workspace &&
            activeWorkspaceV2 &&
            Number(workspace.patient.id) === Number(activeWorkspaceV2.patient.id)
        );
    }

    function copySetV2(target, source) {
        target.clear();
        source.forEach(value => target.add(value));
    }

    function syncGlobalsV2(workspace) {
        if (!workspace || !isActiveV2(workspace)) return;

        currentPatient = workspace.patient;
        currentVisit = workspace.visitId;
        visitCreationPromise = workspace.visitPromise;
        conversation = workspace.conversation;
        currentRecord = workspace.record;
        isGeneratingRecord = workspace.generationRunning;
        pendingAutoGeneration = workspace.generationPending;
        generationSequence = workspace.generationSequence;
        caseChatHistory = workspace.chatHistory;
        isCaseChatting = workspace.chatRunning;
        isTranscribing = workspace.transcribeCount > 0;
        isImportingText = workspace.importCount > 0;
        currentSpeaker = workspace.currentSpeaker || "mixed";
        copySetV2(manualSections, workspace.manualSections);
    }

    function saveActiveDraftV2() {
        const workspace = activeWorkspaceV2;
        if (!workspace) return;

        try {
            workspace.record = collectTemplateSections();
        } catch (_) {
            workspace.record = currentRecord || workspace.record;
        }

        workspace.textDraft =
            document.getElementById("transcript-text-input")?.value || "";
        workspace.chatDraft =
            document.getElementById("case-chat-input")?.value || "";
        workspace.currentSpeaker = currentSpeaker;
        workspace.uploadSpeaker =
            document.getElementById("upload-speaker")?.value || "mixed";
        workspace.textSpeaker =
            document.getElementById("text-import-speaker")?.value || "mixed";
        workspace.manualSections = new Set(manualSections);
        workspace.conversation = conversation;
        workspace.record = currentRecord || workspace.record;
        workspace.chatHistory = caseChatHistory;
        window.dentalMultimodalV21?.onWorkspaceDraftSaved?.(workspace);
    }

    function activeTasksV2(workspace) {
        if (!workspace) return [];
        return [...workspace.tasks.values()]
            .filter(task => task.status === "running");
    }

    function failedTasksV2(workspace) {
        if (!workspace) return [];
        return [...workspace.tasks.values()]
            .filter(task => task.status === "failed");
    }

    function makeTaskV2(workspace, type, label) {
        const task = {
            id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type,
            label,
            detail: "处理中",
            status: "running",
            startedAt: new Date().toISOString()
        };
        workspace.tasks.set(task.id, task);
        refreshTasksV2(workspace);
        return task;
    }

    function updateTaskV2(workspace, task, detail) {
        if (!workspace || !task) return;
        task.detail = detail || task.detail;
        refreshTasksV2(workspace);
    }

    function completeTaskV2(workspace, task, detail = "已完成") {
        if (!workspace || !task) return;
        task.status = "done";
        task.detail = detail;
        task.finishedAt = new Date().toISOString();
        refreshTasksV2(workspace);

        setTimeout(() => {
            if (workspace.tasks.get(task.id)?.status === "done") {
                workspace.tasks.delete(task.id);
                refreshTasksV2(workspace);
            }
        }, 12000);
    }

    function failTaskV2(workspace, task, error) {
        if (!workspace || !task) return;
        task.status = "failed";
        task.detail = String(error || "处理失败");
        task.finishedAt = new Date().toISOString();
        refreshTasksV2(workspace);
    }

    function refreshGlobalTaskBadgeV2() {
        const total = [...patientWorkspacesV2.values()]
            .reduce((sum, workspace) => sum + activeTasksV2(workspace).length, 0);
        const badge = document.getElementById("global-task-status");

        if (badge) {
            badge.textContent = `后台任务 ${total}`;
            badge.classList.toggle("hidden", total === 0);
            badge.classList.toggle("flex", total > 0);
        }

        if (!document.getElementById("patient-modal")?.classList.contains("hidden")) {
            renderPatientList([...patientCache.values()]);
        }
    }

    function renderWorkspaceTaskStatusV2(workspace = activeWorkspaceV2) {
        const element = document.getElementById("workspace-task-status");
        if (!element) return;

        const active = activeTasksV2(workspace);
        const failed = failedTasksV2(workspace);

        if (active.length) {
            element.textContent =
                `后台处理中 ${active.length} 项，可切换其他患者继续工作`;
            element.className = "text-xs text-amber-600 mt-1";
        } else if (failed.length) {
            element.textContent =
                `有 ${failed.length} 项任务失败，请查看对话区`;
            element.className = "text-xs text-red-600 mt-1";
        } else {
            element.textContent = "当前患者无后台任务";
            element.className = "text-xs text-gray-400 mt-1";
        }
    }

    function refreshTasksV2(workspace) {
        refreshGlobalTaskBadgeV2();
        if (isActiveV2(workspace)) {
            renderWorkspaceTaskStatusV2(workspace);
            renderConversationList(workspace);
            updateControlsV2();
        }
    }

    function workspaceLogV2(workspace, message) {
        if (!workspace) return;
        workspace.logs.unshift({
            time: new Date().toLocaleTimeString(),
            message: String(message)
        });
        workspace.logs = workspace.logs.slice(0, 100);
        if (isActiveV2(workspace)) renderLogsV2(workspace);
    }

    function renderLogsV2(workspace = activeWorkspaceV2) {
        const panel = document.getElementById("log-panel");
        if (!panel) return;

        if (!workspace || !workspace.logs.length) {
            panel.innerHTML = '<p class="text-gray-400">系统就绪...</p>';
            return;
        }

        panel.innerHTML = workspace.logs
            .map(item =>
                `<p class="text-gray-600">[${escapeHtml(item.time)}] ${escapeHtml(item.message)}</p>`
            )
            .join("");
    }

    function renderInfoV2(workspace = activeWorkspaceV2) {
        ["主诉", "现病史", "检查所见", "诊断线索"].forEach(field => {
            const element = document.getElementById(`info-${field}`);
            if (!element) return;
            const value = workspace?.extracted?.[field];
            element.textContent = Array.isArray(value)
                ? value.join("、")
                : (value || "等待录音...");
            element.className = value
                ? "text-sm text-gray-800"
                : "text-sm text-gray-400";
        });
    }

    function renderChatV2(workspace = activeWorkspaceV2) {
        const panel = document.getElementById("case-chat-messages");
        if (!panel) return;

        panel.innerHTML = "";
        const notice = document.createElement("div");
        notice.className =
            "rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-700";
        notice.textContent = workspace
            ? `当前问答对象：${workspace.patient.name}。模型只读取该患者的资料、录音、病历和知识库。`
            : "选择患者后可基于患者、录音、病历和知识库进行本地问答。";
        panel.appendChild(notice);

        if (!workspace) return;

        workspace.chatHistory.forEach(item => {
            if (item.role === "system_notice") {
                const node = document.createElement("div");
                node.className = "text-center text-[11px] text-gray-400 px-2";
                node.textContent = item.content;
                panel.appendChild(node);
            } else {
                appendCaseChatMessage(item.role, item.content);
            }
        });

        if (workspace.chatRunning) {
            appendCaseChatMessage("assistant", "", {loading: true});
        }
        panel.scrollTop = panel.scrollHeight;
    }

    function setVisitStatusV2(text, state = "pending", workspace = activeWorkspaceV2) {
        if (workspace) {
            workspace.status.visit = text;
            workspace.status.visitState = state;
        }
        if (workspace && !isActiveV2(workspace)) return;

        const element = document.getElementById("visit-status");
        if (!element) return;
        element.textContent = text;
        element.className = "text-xs text-gray-400";
        if (state === "ready") element.classList.add("visit-ready");
        if (state === "error") element.classList.add("visit-error");
    }

    function updateControlsV2() {
        const workspace = activeWorkspaceV2;
        const hasPatient = Boolean(workspace);
        const recordingOther = Boolean(
            isRecording &&
            activeRecordingV2 &&
            activeRecordingV2.workspace !== workspace
        );
        const blockFileInputs = !hasPatient || isRecording;

        const recordButton = document.getElementById("record-btn");
        if (recordButton) {
            recordButton.disabled = !hasPatient || recordingOther;
            recordButton.classList.toggle("opacity-60", recordButton.disabled);
            recordButton.classList.toggle(
                "cursor-not-allowed",
                recordButton.disabled
            );
        }

        [
            "audio-file-input",
            "upload-speaker",
            "transcript-file-input",
            "text-import-speaker",
            "transcript-text-input",
            "btn-paste-transcript",
            "btn-import-transcript"
        ].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = blockFileInputs;
        });

        ["audio-drop-zone", "transcript-drop-zone"].forEach(id => {
            const element = document.getElementById(id);
            if (!element) return;
            element.classList.toggle("opacity-60", blockFileInputs);
            element.classList.toggle("cursor-not-allowed", blockFileInputs);
        });

        const generate = document.getElementById("btn-generate");
        const canGenerate = Boolean(
            workspace &&
            workspace.visitId &&
            workspace.conversation.length &&
            !workspace.generationRunning
        );
        if (generate) {
            generate.disabled = !canGenerate;
            generate.className = canGenerate
                ? "w-full py-3 rounded-xl bg-blue-600 text-white font-bold transition hover:bg-blue-700 flex items-center justify-center gap-2"
                : "w-full py-3 rounded-xl bg-gray-300 text-white font-bold transition flex items-center justify-center gap-2 disabled:cursor-not-allowed";
        }

        const send = document.getElementById("case-chat-send");
        const chatInput = document.getElementById("case-chat-input");
        if (send) {
            send.disabled = !hasPatient || Boolean(workspace?.chatRunning);
            send.textContent = workspace?.chatRunning ? "思考中" : "发送";
        }
        if (chatInput) {
            chatInput.disabled = !hasPatient || Boolean(workspace?.chatRunning);
        }

        window.dentalMultimodalV21?.onControlsUpdated?.(workspace);
    }

    function renderWorkspaceV2(workspace) {
        activeWorkspaceV2 = workspace;
        syncGlobalsV2(workspace);

        document.getElementById("patient-card").classList.remove("hidden");
        document.getElementById("no-patient").classList.add("hidden");
        renderCurrentPatient();

        setVisitStatusV2(
            workspace.status.visit,
            workspace.status.visitState,
            workspace
        );
        renderWorkspaceTaskStatusV2(workspace);

        setSpeaker(workspace.currentSpeaker || "mixed");
        document.getElementById("upload-speaker").value =
            workspace.uploadSpeaker || "mixed";
        document.getElementById("text-import-speaker").value =
            workspace.textSpeaker || "mixed";
        document.getElementById("transcript-text-input").value =
            workspace.textDraft || "";
        document.getElementById("case-chat-input").value =
            workspace.chatDraft || "";

        document.getElementById("record-status").textContent =
            workspace.status.record;
        document.getElementById("upload-status").textContent =
            workspace.status.upload;
        document.getElementById("text-import-status").textContent =
            workspace.status.textImport;

        const autoStatus = document.getElementById("auto-fill-status");
        autoStatus.textContent = workspace.status.autoFill;
        autoStatus.className = workspace.generationRunning
            ? "text-xs text-center text-blue-600 mb-2 auto-fill-running"
            : "text-xs text-center text-gray-500 mb-2";

        document.getElementById("case-chat-status").textContent =
            workspace.status.chat;

        const fileInfo = document.getElementById("upload-file-info");
        if (workspace.lastAudioFile) {
            fileInfo.textContent = workspace.lastAudioFile;
            fileInfo.classList.remove("hidden");
        } else {
            fileInfo.classList.add("hidden");
        }

        renderConversationList(workspace);
        renderRecordEditor(workspace.record || emptyRecord());
        renderInfoV2(workspace);
        renderChatV2(workspace);
        renderLogsV2(workspace);

        document.getElementById("btn-save").disabled = !workspace.visitId;
        document.getElementById("btn-export").disabled = !workspace.visitId;
        document.getElementById("loading-overlay").classList.add("hidden");

        updateControlsV2();
        window.dentalMultimodalV21?.onWorkspaceRendered?.(workspace);
    }

    function activateWorkspaceV2(workspace) {
        if (activeWorkspaceV2 && activeWorkspaceV2 !== workspace) {
            saveActiveDraftV2();
        }
        renderWorkspaceV2(workspace);
    }

    async function ensureVisitV2(workspace = activeWorkspaceV2) {
        if (!workspace) {
            alert("请先选择患者");
            return null;
        }
        if (workspace.visitId) return workspace.visitId;
        if (workspace.visitPromise) return await workspace.visitPromise;

        setVisitStatusV2("正在创建就诊记录...", "pending", workspace);
        workspace.visitPromise = (async () => {
            try {
                const visitId = await createVisitForPatient(workspace.patient.id);
                workspace.visitId = visitId;
                setVisitStatusV2(
                    `就诊记录 #${visitId} 已创建`,
                    "ready",
                    workspace
                );
                workspaceLogV2(workspace, `开始初诊记录 #${visitId}`);
                if (isActiveV2(workspace)) {
                    syncGlobalsV2(workspace);
                    document.getElementById("btn-save").disabled = false;
                    document.getElementById("btn-export").disabled = false;
                    updateControlsV2();
                }
                return visitId;
            } catch (error) {
                workspace.visitId = null;
                setVisitStatusV2(
                    "就诊记录创建失败：" + error.message,
                    "error",
                    workspace
                );
                workspaceLogV2(
                    workspace,
                    "创建就诊记录失败：" + error.message
                );
                if (isActiveV2(workspace)) {
                    alert("无法创建就诊记录：" + error.message);
                }
                return null;
            } finally {
                workspace.visitPromise = null;
                if (isActiveV2(workspace)) syncGlobalsV2(workspace);
            }
        })();
        return await workspace.visitPromise;
    }

    function addConversationV2(workspace, speaker, text, metadata = {}) {
        const entry = {
            id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            speaker,
            text,
            time: new Date().toISOString(),
            source: metadata.source || "live",
            filename: metadata.filename || "",
            duration: metadata.duration || "",
            format: metadata.format || "",
            chars: metadata.chars || text.length,
            originalChars: metadata.originalChars || text.length,
            truncated: Boolean(metadata.truncated)
        };
        workspace.conversation.push(entry);

        if (isActiveV2(workspace)) {
            syncGlobalsV2(workspace);
            renderConversationList(workspace);
            updateControlsV2();
            updateInfoPanel(speaker, text);
        }
    }

    function mergeManualV2(generated, workspace, preserved) {
        const merged = {...generated};
        Object.entries(preserved || {}).forEach(([section, data]) => {
            merged[section] = {
                ...data,
                source: "manual",
                needs_confirm: false
            };
        });
        return merged;
    }

    function manualSnapshotV2(workspace) {
        if (isActiveV2(workspace)) {
            try {
                workspace.record = collectTemplateSections();
            } catch (_) {}
            workspace.manualSections = new Set(manualSections);
        }

        const result = {};
        workspace.manualSections.forEach(section => {
            result[section] = workspace.record?.[section];
        });
        return result;
    }

    async function generateForV2(workspace, automatic) {
        if (
            window.dentalMultimodalV21?.shouldUseVision?.(workspace)
        ) {
            return await window.dentalMultimodalV21.analyzeWorkspace(
                workspace,
                {automatic, source: "record-generation"}
            );
        }

        if (!workspace || !workspace.conversation.length) {
            if (!automatic) {
                alert("请先完成录音、粘贴文字或上传录音/文字文件");
            }
            return;
        }

        if (workspace.generationRunning) {
            workspace.generationPending = true;
            workspace.status.autoFill =
                "已收到新的资料，当前回填完成后会自动再次整理";
            workspaceLogV2(
                workspace,
                "已有回填任务运行，已排队再次整理"
            );
            if (isActiveV2(workspace)) {
                document.getElementById("auto-fill-status").textContent =
                    workspace.status.autoFill;
            }
            return;
        }

        const visitId = await ensureVisitV2(workspace);
        if (!visitId) return;

        workspace.generationRunning = true;
        workspace.generationManual = !automatic;
        const sequence = ++workspace.generationSequence;
        const manualValues = manualSnapshotV2(workspace);
        const conversationSnapshot =
            workspace.conversation.map(item => ({...item}));
        const task = makeTaskV2(
            workspace,
            "病历回填",
            automatic ? "自动整理并回填病历" : "手动重新分析病历"
        );

        workspace.status.autoFill = automatic
            ? "AI正在后台分析该患者资料，可切换其他患者继续工作"
            : "AI正在重新分析该患者完整资料";
        updateTaskV2(workspace, task, "正在调用本地模型和知识库");

        if (isActiveV2(workspace)) {
            syncGlobalsV2(workspace);
            const status = document.getElementById("auto-fill-status");
            status.textContent = workspace.status.autoFill;
            status.className =
                "text-xs text-center text-blue-600 mb-2 auto-fill-running";
            if (!automatic) {
                document.getElementById("loading-overlay")
                    .classList.remove("hidden");
            }
            updateControlsV2();
        }

        try {
            const response = await fetch(`${API_BASE}/api/generate`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    visit_id: visitId,
                    conversation: conversationSnapshot
                })
            });

            let data = {};
            try { data = await response.json(); } catch (_) {}

            if (!response.ok || !data.record) {
                throw new Error(
                    data.detail ||
                    data.error ||
                    `生成失败（HTTP ${response.status}）`
                );
            }

            if (sequence !== workspace.generationSequence) return;

            workspace.record = mergeManualV2(
                data.record,
                workspace,
                manualValues
            );
            workspace.extracted = data.extracted || {};
            workspace.status.autoFill = workspace.manualSections.size
                ? `自动回填完成，已保留 ${workspace.manualSections.size} 个手工修改版块`
                : "自动回填完成，请医生逐项审核";
            completeTaskV2(workspace, task, "病历模板已回填");
            workspaceLogV2(
                workspace,
                `病历自动回填完成${data.kb_used ? "，已使用本地知识库" : ""}`
            );

            if (isActiveV2(workspace)) {
                syncGlobalsV2(workspace);
                renderRecordEditor(workspace.record);
                renderInfoV2(workspace);
                document.getElementById("btn-save").disabled = false;
                document.getElementById("btn-export").disabled = false;
                const status = document.getElementById("auto-fill-status");
                status.textContent = workspace.status.autoFill;
                status.className =
                    "text-xs text-center text-green-600 mb-2";
            }
        } catch (error) {
            workspace.status.autoFill =
                "自动回填失败：" + error.message;
            failTaskV2(workspace, task, error.message);
            workspaceLogV2(
                workspace,
                "自动回填失败：" + error.message
            );

            if (isActiveV2(workspace)) {
                const status = document.getElementById("auto-fill-status");
                status.textContent = workspace.status.autoFill;
                status.className =
                    "text-xs text-center text-red-600 mb-2";
                if (!automatic) {
                    alert("生成失败：" + error.message);
                }
            }
        } finally {
            workspace.generationRunning = false;
            workspace.generationManual = false;

            if (isActiveV2(workspace)) {
                syncGlobalsV2(workspace);
                document.getElementById("loading-overlay")
                    .classList.add("hidden");
                updateControlsV2();
            }
            refreshTasksV2(workspace);

            if (workspace.generationPending) {
                workspace.generationPending = false;
                setTimeout(
                    () => generateForV2(workspace, true),
                    180
                );
            }
        }
    }

    async function uploadAudioV2(
        workspace,
        audioData,
        filename,
        speaker,
        source
    ) {
        const task = makeTaskV2(
            workspace,
            "录音转写",
            source === "live"
                ? "实时录音转写"
                : `录音转写：${filename}`
        );
        workspace.transcribeCount += 1;

        if (source === "file") {
            workspace.status.upload =
                "录音正在后台等待或执行转写，可切换患者继续工作";
        } else {
            workspace.status.record =
                "录音正在后台等待或执行转写，可切换患者继续工作";
        }

        if (isActiveV2(workspace)) {
            syncGlobalsV2(workspace);
            document.getElementById("upload-status").textContent =
                workspace.status.upload;
            document.getElementById("record-status").textContent =
                workspace.status.record;
        }

        const formData = new FormData();
        formData.append("audio", audioData, filename);
        formData.append("patient_id", String(workspace.patient.id));
        if (workspace.visitId) {
            formData.append("visit_id", String(workspace.visitId));
        }

        try {
            updateTaskV2(
                workspace,
                task,
                "正在等待或执行本地语音转写"
            );
            const response = await fetch(`${API_BASE}/api/transcribe`, {
                method: "POST",
                body: formData
            });

            let data = {};
            try { data = await response.json(); } catch (_) {}

            if (!response.ok) {
                throw new Error(
                    data.detail || `服务器返回 ${response.status}`
                );
            }
            if (!data.text) {
                throw new Error("未识别到清晰语音，请检查录音内容或音量");
            }

            addConversationV2(
                workspace,
                speaker,
                data.text,
                {
                    source,
                    filename: data.filename || filename,
                    duration: String(data.duration || "")
                }
            );

            const durationText = data.duration
                ? `，时长 ${data.duration} 秒`
                : "";

            if (source === "file") {
                workspace.status.upload =
                    `转写完成${durationText}，已加入该患者对话`;
            } else {
                workspace.status.record =
                    `转写完成${durationText}，已加入该患者对话`;
            }

            completeTaskV2(workspace, task, "转写完成");
            workspaceLogV2(
                workspace,
                `转写完成：${data.filename || filename}${durationText}`
            );

            if (isActiveV2(workspace)) {
                document.getElementById("upload-status").textContent =
                    workspace.status.upload;
                document.getElementById("record-status").textContent =
                    workspace.status.record;
            }

            if (isAutoFillEnabled()) {
                workspace.status.autoFill =
                    "转写完成，正在后台自动分析并回填";
                if (isActiveV2(workspace)) {
                    document.getElementById("auto-fill-status").textContent =
                        workspace.status.autoFill;
                }
                await generateForV2(workspace, true);
            } else {
                workspace.status.autoFill =
                    "转写完成，可手动重新分析并回填";
            }
        } catch (error) {
            failTaskV2(workspace, task, error.message);
            if (source === "file") {
                workspace.status.upload =
                    "转写失败：" + error.message;
            } else {
                workspace.status.record =
                    "转写失败：" + error.message;
            }
            workspaceLogV2(
                workspace,
                "转写失败：" + error.message
            );

            if (isActiveV2(workspace)) {
                document.getElementById("upload-status").textContent =
                    workspace.status.upload;
                document.getElementById("record-status").textContent =
                    workspace.status.record;
            }
        } finally {
            workspace.transcribeCount =
                Math.max(0, workspace.transcribeCount - 1);
            if (isActiveV2(workspace)) syncGlobalsV2(workspace);
            refreshTasksV2(workspace);
        }
    }

    async function finishTextImportV2(
        workspace,
        text,
        speaker,
        metadata
    ) {
        addConversationV2(workspace, speaker, text, metadata);
        const truncateText = metadata.truncated
            ? `；原文 ${metadata.originalChars} 字，已按上下文限制保留首尾`
            : "";
        workspace.status.textImport =
            `已导入 ${metadata.chars || text.length} 字${truncateText}`;
        workspaceLogV2(
            workspace,
            `录音文字已加入对话：${metadata.filename || metadata.format || "粘贴文字"}`
        );

        if (isActiveV2(workspace)) {
            document.getElementById("text-import-status").textContent =
                workspace.status.textImport;
        }

        if (isAutoFillEnabled()) {
            workspace.status.autoFill =
                "文字导入完成，正在后台自动分析并回填";
            if (isActiveV2(workspace)) {
                document.getElementById("auto-fill-status").textContent =
                    workspace.status.autoFill;
            }
            await generateForV2(workspace, true);
        } else {
            workspace.status.autoFill =
                "文字已导入，可手动重新分析并回填";
        }
    }

    // -------- Patient list and selection --------
    renderPatientList = function(patients) {
        const list = document.getElementById("patient-list");
        patientCache.clear();

        if (!patients.length) {
            list.innerHTML =
                '<p class="text-center text-gray-400 py-4">暂无患者</p>';
            return;
        }

        patients.forEach(patient =>
            patientCache.set(Number(patient.id), patient)
        );

        list.innerHTML = patients.map(patient => {
            const workspace =
                patientWorkspacesV2.get(Number(patient.id));
            const activeCount = activeTasksV2(workspace).length;
            const failedCount = failedTasksV2(workspace).length;
            const badge = activeCount
                ? `<span class="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">处理中 ${activeCount}</span>`
                : (failedCount
                    ? '<span class="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full">有失败任务</span>'
                    : "");

            return `
                <div onclick="selectPatientFromCache(${Number(patient.id)})"
                    class="p-3 border rounded-lg mb-2 cursor-pointer hover:bg-blue-50 transition">
                    <div class="flex justify-between gap-3">
                        <span class="font-bold truncate">${escapeHtml(patient.name)}</span>
                        <span class="text-xs text-gray-500 shrink-0">${escapeHtml(patient.phone || "")}</span>
                    </div>
                    <div class="flex items-center justify-between gap-2 mt-1">
                        <div class="text-xs text-gray-500">
                            ${escapeHtml(patient.gender || "")}
                            ${patient.age !== null && patient.age !== undefined
                                ? escapeHtml(patient.age) + "岁"
                                : ""}
                            | 过敏：${escapeHtml(patient.allergy || "否认")}
                        </div>
                        ${badge}
                    </div>
                </div>
            `;
        }).join("");
    };

    selectPatient = async function(
        id,
        name,
        gender,
        age,
        phone,
        allergy
    ) {
        const targetId = Number(id);

        if (
            isRecording &&
            activeRecordingV2 &&
            Number(activeRecordingV2.workspace.patient.id) !== targetId
        ) {
            alert(
                "当前正在录音，请先停止录音后再切换患者。停止后进入后台转写即可自由切换。"
            );
            return;
        }

        const workspace = workspaceForV2({
            id: targetId,
            name,
            gender,
            age,
            phone,
            allergy
        });
        activateWorkspaceV2(workspace);
        closePatientModal();
        ensureVisitV2(workspace);
    };

    updatePatient = async function() {
        const workspace = activeWorkspaceV2;
        if (!workspace) return;

        const ageRaw =
            document.getElementById("edit-age").value.trim();
        const body = {
            name: document.getElementById("edit-name").value.trim(),
            gender: document.getElementById("edit-gender").value,
            age: ageRaw === "" ? null : Number(ageRaw),
            phone: document.getElementById("edit-phone").value.trim(),
            allergy:
                document.getElementById("edit-allergy").value.trim() ||
                "否认"
        };

        if (!body.name) {
            alert("请输入患者姓名");
            return;
        }
        if (
            body.age !== null &&
            (!Number.isInteger(body.age) ||
                body.age < 0 ||
                body.age > 150)
        ) {
            alert("年龄应为 0 至 150 之间的整数");
            return;
        }

        const button = document.getElementById("btn-update-patient");
        button.disabled = true;
        button.textContent = "保存中...";

        try {
            const response = await fetch(
                `${API_BASE}/api/patients/${workspace.patient.id}`,
                {
                    method: "PUT",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify(body)
                }
            );

            let data = {};
            try { data = await response.json(); } catch (_) {}
            if (!response.ok) {
                throw new Error(
                    data.detail || `保存失败（HTTP ${response.status}）`
                );
            }

            workspace.patient = data;
            patientCache.set(Number(data.id), data);
            if (isActiveV2(workspace)) {
                currentPatient = data;
                renderCurrentPatient();
                appendCaseSystemMessage(
                    "患者基本信息已更新，后续问答将使用最新资料。",
                    workspace
                );
            }
            closeEditPatientModal();
            workspaceLogV2(workspace, `已修改患者信息：${data.name}`);
        } catch (error) {
            alert("修改患者信息失败：" + error.message);
            workspaceLogV2(
                workspace,
                "修改患者信息失败：" + error.message
            );
        } finally {
            button.disabled = false;
            button.textContent = "保存修改";
        }
    };

    ensureVisit = ensureVisitV2;
    setVisitStatus = setVisitStatusV2;
    updateRecordingAvailability = updateControlsV2;
    setTranscribingState = () => updateControlsV2();
    setTextImportState = () => updateControlsV2();

    // -------- Recording --------
    toggleRecording = async function() {
        const workspace = activeWorkspaceV2;
        if (!workspace) {
            alert("请先选择患者");
            return;
        }

        if (isRecording) {
            stopRecording();
            return;
        }

        const visitId = await ensureVisitV2(workspace);
        if (!visitId) return;
        startRecording(workspace);
    };

    startRecording = async function(workspace = activeWorkspaceV2) {
        if (!workspace) return;

        try {
            const stream =
                await navigator.mediaDevices.getUserMedia({audio: true});
            const options = MediaRecorder.isTypeSupported("audio/webm")
                ? {mimeType: "audio/webm"}
                : undefined;
            mediaRecorder = options
                ? new MediaRecorder(stream, options)
                : new MediaRecorder(stream);

            const chunks = [];
            const speaker = workspace.currentSpeaker || currentSpeaker;
            activeRecordingV2 = {workspace, speaker, stream};
            recordingContext = activeRecordingV2;

            mediaRecorder.ondataavailable = event => {
                if (event.data && event.data.size > 0) {
                    chunks.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                const context =
                    activeRecordingV2 || {workspace, speaker, stream};
                const mimeType =
                    mediaRecorder.mimeType || "audio/webm";
                const blob = new Blob(chunks, {type: mimeType});
                const filename = mimeType.includes("webm")
                    ? "recording.webm"
                    : "recording.wav";

                try {
                    await uploadAudioV2(
                        context.workspace,
                        blob,
                        filename,
                        context.speaker,
                        "live"
                    );
                } finally {
                    context.stream.getTracks()
                        .forEach(track => track.stop());
                    if (activeRecordingV2 === context) {
                        activeRecordingV2 = null;
                        recordingContext = null;
                    }
                    updateControlsV2();
                }
            };

            mediaRecorder.start();
            isRecording = true;
            workspace.status.record =
                `正在录音（${speakerLabel(speaker)}）... 停止后在后台转写`;

            if (isActiveV2(workspace)) {
                const button =
                    document.getElementById("record-btn");
                button.className =
                    "w-full py-4 rounded-xl bg-red-600 text-white font-bold transition recording-pulse flex items-center justify-center gap-2";
                button.innerHTML =
                    '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path></svg> 停止录音';
                document.getElementById("waveform")
                    .classList.remove("hidden");
                document.getElementById("record-status").textContent =
                    workspace.status.record;
            }

            workspaceLogV2(
                workspace,
                `开始录音：${speakerLabel(speaker)}`
            );
            updateControlsV2();
        } catch (error) {
            alert("无法访问麦克风：" + error.message);
        }
    };

    stopRecording = function() {
        const workspace =
            activeRecordingV2?.workspace || activeWorkspaceV2;

        if (
            mediaRecorder &&
            mediaRecorder.state !== "inactive"
        ) {
            mediaRecorder.stop();
        }
        isRecording = false;

        if (workspace) {
            workspace.status.record =
                "录音已停止，正在后台等待或执行转写";
            workspaceLogV2(
                workspace,
                "停止录音，已提交后台转写"
            );
        }

        if (isActiveV2(workspace)) {
            const button =
                document.getElementById("record-btn");
            button.className =
                "w-full py-4 rounded-xl bg-gray-200 text-gray-500 font-bold transition flex items-center justify-center gap-2";
            button.innerHTML =
                '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg> 开始录音';
            document.getElementById("waveform")
                .classList.add("hidden");
            document.getElementById("record-status").textContent =
                workspace.status.record;
        }

        updateControlsV2();
    };

    handleAudioDrag = function(event, active) {
        event.preventDefault();
        event.stopPropagation();
        const zone = document.getElementById("audio-drop-zone");
        zone.classList.toggle(
            "drop-zone-active",
            Boolean(activeWorkspaceV2) && !isRecording && active
        );
    };

    processAudioFile = async function(file) {
        const workspace = activeWorkspaceV2;
        if (!workspace) {
            alert("请先选择患者");
            return;
        }
        if (isRecording) {
            alert("请先停止实时录音");
            return;
        }

        const visitId = await ensureVisitV2(workspace);
        if (!visitId) return;

        try {
            validateAudioFile(file);
            const speaker =
                document.getElementById("upload-speaker").value;
            workspace.uploadSpeaker = speaker;
            workspace.lastAudioFile =
                `${file.name} · ${formatFileSize(file.size)} · ${speakerLabel(speaker)}`;
            workspace.status.upload =
                "文件已提交后台转写，可切换患者继续工作";

            if (isActiveV2(workspace)) {
                const info =
                    document.getElementById("upload-file-info");
                info.textContent = workspace.lastAudioFile;
                info.classList.remove("hidden");
                document.getElementById("upload-status").textContent =
                    workspace.status.upload;
            }

            workspaceLogV2(
                workspace,
                `上传录音：${file.name}（${formatFileSize(file.size)}）`
            );
            uploadAudioV2(
                workspace,
                file,
                file.name,
                speaker,
                "file"
            );
        } catch (error) {
            workspace.status.upload =
                "录音文件处理失败：" + error.message;
            workspaceLogV2(workspace, workspace.status.upload);
            if (isActiveV2(workspace)) {
                document.getElementById("upload-status").textContent =
                    workspace.status.upload;
                alert(error.message);
            }
        }
    };

    uploadAudio = async function(
        audioData,
        filename,
        speaker,
        source,
        workspace = activeWorkspaceV2
    ) {
        return uploadAudioV2(
            workspace,
            audioData,
            filename,
            speaker,
            source
        );
    };

    // -------- Text import --------
    pasteTranscriptFromClipboard = async function() {
        const workspace = activeWorkspaceV2;
        if (!workspace || isRecording) return;

        const input =
            document.getElementById("transcript-text-input");
        try {
            const text = await navigator.clipboard.readText();
            if (!text.trim()) throw new Error("剪贴板中没有文字");

            workspace.textDraft = text;
            input.value = text;
            workspace.status.textImport =
                `已从剪贴板粘贴 ${text.trim().length} 字，请点击“导入文字并回填”`;
            document.getElementById("text-import-status").textContent =
                workspace.status.textImport;
            input.focus();
        } catch (_) {
            input.focus();
            workspace.status.textImport =
                "浏览器未允许读取剪贴板，请在输入框按 Ctrl+V 粘贴";
            document.getElementById("text-import-status").textContent =
                workspace.status.textImport;
        }
    };

    importPastedTranscript = async function() {
        const workspace = activeWorkspaceV2;
        if (!workspace) {
            alert("请先选择患者");
            return;
        }

        const visitId = await ensureVisitV2(workspace);
        if (!visitId) return;

        const input =
            document.getElementById("transcript-text-input");
        const limited = limitTranscriptText(input.value);
        if (!limited.text) {
            alert("请先粘贴录音文字");
            input.focus();
            return;
        }

        const speaker =
            document.getElementById("text-import-speaker").value;
        workspace.textSpeaker = speaker;
        workspace.textDraft = "";
        const task = makeTaskV2(
            workspace,
            "文字导入",
            "导入剪贴板录音文字"
        );
        workspace.importCount += 1;

        try {
            await finishTextImportV2(
                workspace,
                limited.text,
                speaker,
                {
                    source: "text_paste",
                    filename: "剪贴板文字",
                    format: "粘贴",
                    chars: limited.text.length,
                    originalChars: limited.originalChars,
                    truncated: limited.truncated
                }
            );
            completeTaskV2(
                workspace,
                task,
                "文字已加入患者对话"
            );
            if (isActiveV2(workspace)) input.value = "";
        } catch (error) {
            failTaskV2(workspace, task, error.message);
            workspace.status.textImport =
                "导入失败：" + error.message;
            workspaceLogV2(
                workspace,
                workspace.status.textImport
            );
            if (isActiveV2(workspace)) alert(error.message);
        } finally {
            workspace.importCount =
                Math.max(0, workspace.importCount - 1);
            if (isActiveV2(workspace)) syncGlobalsV2(workspace);
            refreshTasksV2(workspace);
        }
    };

    handleTranscriptDrag = function(event, active) {
        event.preventDefault();
        event.stopPropagation();
        const zone =
            document.getElementById("transcript-drop-zone");
        zone.classList.toggle(
            "drop-zone-active",
            Boolean(activeWorkspaceV2) && !isRecording && active
        );
    };

    processTranscriptFile = async function(file) {
        const workspace = activeWorkspaceV2;
        if (!workspace) {
            alert("请先选择患者");
            return;
        }
        if (isRecording) {
            alert("请先停止实时录音");
            return;
        }

        const visitId = await ensureVisitV2(workspace);
        if (!visitId) return;

        try {
            validateTranscriptFile(file);
        } catch (error) {
            alert(error.message);
            return;
        }

        const task = makeTaskV2(
            workspace,
            "文字导入",
            `读取文字文件：${file.name}`
        );
        workspace.importCount += 1;
        workspace.status.textImport =
            `正在后台读取 ${file.name}，可切换患者继续工作`;
        if (isActiveV2(workspace)) {
            document.getElementById("text-import-status").textContent =
                workspace.status.textImport;
        }
        workspaceLogV2(
            workspace,
            `导入文字文件：${file.name}（${formatFileSize(file.size)}）`
        );

        try {
            const formData = new FormData();
            formData.append("document", file, file.name);

            const response = await fetch(`${API_BASE}/api/import-text`, {
                method: "POST",
                body: formData
            });

            let data = {};
            try { data = await response.json(); } catch (_) {}

            if (!response.ok || !data.text) {
                throw new Error(
                    data.detail ||
                    `文件解析失败（HTTP ${response.status}）`
                );
            }

            await finishTextImportV2(
                workspace,
                data.text,
                workspace.textSpeaker || "mixed",
                {
                    source: "text_file",
                    filename: data.filename || file.name,
                    format: data.format || "",
                    chars: data.chars || data.text.length,
                    originalChars:
                        data.original_chars || data.text.length,
                    truncated: Boolean(data.truncated)
                }
            );
            completeTaskV2(
                workspace,
                task,
                "文件文字已加入患者对话"
            );
        } catch (error) {
            failTaskV2(workspace, task, error.message);
            workspace.status.textImport =
                "导入失败：" + error.message;
            workspaceLogV2(
                workspace,
                workspace.status.textImport
            );
            if (isActiveV2(workspace)) {
                document.getElementById("text-import-status").textContent =
                    workspace.status.textImport;
                alert(error.message);
            }
        } finally {
            workspace.importCount =
                Math.max(0, workspace.importCount - 1);
            if (isActiveV2(workspace)) syncGlobalsV2(workspace);
            refreshTasksV2(workspace);
        }
    };

    finishTranscriptImport = async function(
        text,
        speaker,
        metadata,
        workspace = activeWorkspaceV2
    ) {
        return finishTextImportV2(
            workspace,
            text,
            speaker,
            metadata
        );
    };

    // -------- Conversation and record --------
    addConversation = function(speaker, text, metadata = {}) {
        if (!activeWorkspaceV2) return;
        addConversationV2(
            activeWorkspaceV2,
            speaker,
            text,
            metadata
        );
    };

    removeConversation = function(id) {
        const workspace = activeWorkspaceV2;
        if (!workspace) return;
        workspace.conversation =
            workspace.conversation.filter(item => item.id !== id);
        syncGlobalsV2(workspace);
        renderConversationList(workspace);
        updateControlsV2();
        workspaceLogV2(workspace, "已删除一条对话记录");
    };

    renderConversationList = function(
        workspace = activeWorkspaceV2
    ) {
        const list = document.getElementById("conversation-list");
        if (!list) return;

        if (!workspace) {
            list.innerHTML =
                '<p class="text-center text-gray-400 text-sm py-4">暂无对话记录</p>';
            return;
        }

        const taskHtml = [...workspace.tasks.values()]
            .filter(task =>
                task.status === "running" ||
                task.status === "failed"
            )
            .map(task => {
                const failed = task.status === "failed";
                return `
                    <div class="patient-task-card ${failed ? "patient-task-failed" : ""}">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-xs font-bold ${failed ? "text-red-700" : "text-amber-700"}">
                                ${failed ? "处理失败" : "后台处理中"}
                            </span>
                            <span class="text-[10px] text-gray-400">${escapeHtml(task.type)}</span>
                        </div>
                        <p class="text-sm text-gray-700 mt-1">${escapeHtml(task.label)}</p>
                        <p class="text-xs text-gray-500 mt-1">${escapeHtml(task.detail)}</p>
                    </div>
                `;
            })
            .join("");

        const conversationHtml = workspace.conversation
            .map(item => {
                const isDoctor = item.speaker === "doctor";
                const isPatient = item.speaker === "patient";
                const cardClass = isDoctor
                    ? "bg-blue-50 ml-4"
                    : (isPatient
                        ? "bg-gray-50 mr-4"
                        : "bg-purple-50");
                const labelClass = isDoctor
                    ? "speaker-doctor"
                    : (isPatient
                        ? "speaker-patient"
                        : "text-purple-700 font-bold");
                let fileMeta = "";

                if (item.source === "file") {
                    fileMeta =
                        `<p class="text-xs text-gray-400 mt-1">录音：${escapeHtml(item.filename)}${item.duration ? ` · ${escapeHtml(item.duration)} 秒` : ""}</p>`;
                } else if (item.source === "text_file") {
                    fileMeta =
                        `<p class="text-xs text-gray-400 mt-1">文字文件：${escapeHtml(item.filename)}${item.format ? ` · ${escapeHtml(item.format)}` : ""} · ${escapeHtml(item.chars)} 字${item.truncated ? " · 已保留首尾" : ""}</p>`;
                } else if (item.source === "text_paste") {
                    fileMeta =
                        `<p class="text-xs text-gray-400 mt-1">剪贴板文字 · ${escapeHtml(item.chars)} 字${item.truncated ? " · 已保留首尾" : ""}</p>`;
                }

                return `
                    <div class="mb-3 p-3 rounded-lg ${cardClass}">
                        <div class="flex justify-between items-center mb-1">
                            <span class="text-xs ${labelClass}">${escapeHtml(speakerLabel(item.speaker))}</span>
                            <button onclick="removeConversation('${item.id}')"
                                class="text-xs text-gray-400 hover:text-red-500">删除</button>
                        </div>
                        <p class="text-sm text-gray-800 whitespace-pre-wrap">${escapeHtml(item.text)}</p>
                        ${fileMeta}
                    </div>
                `;
            })
            .join("");

        list.innerHTML =
            taskHtml ||
            conversationHtml
                ? taskHtml + conversationHtml
                : '<p class="text-center text-gray-400 text-sm py-4">暂无对话记录</p>';
        list.scrollTop = list.scrollHeight;
    };

    updateGenerateButton = updateControlsV2;

    generateRecord = async function(options = {}) {
        const workspace =
            options.workspace || activeWorkspaceV2;
        return generateForV2(
            workspace,
            Boolean(options.automatic)
        );
    };

    markManual = function(section) {
        const workspace = activeWorkspaceV2;
        if (!workspace) return;

        manualSections.add(section);
        workspace.manualSections.add(section);
        if (!workspace.record) workspace.record = emptyRecord();
        if (
            !workspace.record[section] ||
            typeof workspace.record[section] !== "object"
        ) {
            workspace.record[section] = {};
        }
        workspace.record[section].source = "manual";
        workspace.record[section].needs_confirm = false;
        currentRecord = workspace.record;

        const card =
            document.getElementById(`template-section-${section}`);
        if (card) {
            card.classList.remove(
                "ai-content",
                "ai-suggestion",
                "needs-confirm"
            );
            card.classList.add("manual-edit");
        }
        const badges =
            document.getElementById(`badges-${section}`);
        if (badges) {
            badges.innerHTML =
                '<span class="section-badge bg-green-100 text-green-700">手工填写</span>';
        }
    };

    updateInfoPanelFromExtracted = function(
        extracted,
        workspace = activeWorkspaceV2
    ) {
        if (!workspace || !extracted) return;
        workspace.extracted = extracted;
        if (isActiveV2(workspace)) renderInfoV2(workspace);
    };

    saveRecord = async function() {
        const workspace = activeWorkspaceV2;
        if (!workspace) {
            alert("请先选择患者");
            return;
        }

        const visitId = await ensureVisitV2(workspace);
        if (!visitId) return;

        const sections = collectTemplateSections();
        workspace.record = sections;
        currentRecord = sections;

        try {
            const response = await fetch(
                `${API_BASE}/api/records/${visitId}/update`,
                {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({sections})
                }
            );

            let data = {};
            try { data = await response.json(); } catch (_) {}
            if (!response.ok) {
                throw new Error(
                    data.detail ||
                    data.error ||
                    `保存失败（HTTP ${response.status}）`
                );
            }

            document.getElementById("btn-export").disabled = false;
            workspaceLogV2(workspace, "病历已保存");
            alert("病历保存成功！");
        } catch (error) {
            workspaceLogV2(
                workspace,
                "保存失败：" + error.message
            );
            alert("保存失败：" + error.message);
        }
    };

    exportWord = async function() {
        const workspace = activeWorkspaceV2;
        if (!workspace?.visitId) return;

        try {
            const response = await fetch(
                `${API_BASE}/api/export/word/${workspace.visitId}`
            );
            if (!response.ok) {
                throw new Error(
                    `导出失败（HTTP ${response.status}）`
                );
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download =
                `病历_${workspace.patient.name}_${new Date().toISOString().slice(0, 10)}.docx`;
            anchor.click();
            window.URL.revokeObjectURL(url);
            workspaceLogV2(workspace, "Word导出成功");
        } catch (error) {
            workspaceLogV2(
                workspace,
                "导出失败：" + error.message
            );
            alert("导出失败：" + error.message);
        }
    };

    // -------- Isolated case chat --------
    appendCaseSystemMessage = function(
        text,
        workspace = activeWorkspaceV2
    ) {
        if (!workspace) return;
        workspace.chatHistory.push({
            role: "system_notice",
            content: String(text)
        });
        if (isActiveV2(workspace)) renderChatV2(workspace);
    };

    clearCaseChat = function(
        showMessage = true,
        workspace = activeWorkspaceV2
    ) {
        if (!workspace) {
            renderChatV2(null);
            return;
        }

        workspace.chatHistory = [];
        workspace.chatDraft = "";
        workspace.status.chat = showMessage
            ? "问答记录已清空"
            : "数据仅发送至本机部署模型";

        if (isActiveV2(workspace)) {
            caseChatHistory = workspace.chatHistory;
            document.getElementById("case-chat-input").value = "";
            document.getElementById("case-chat-status").textContent =
                workspace.status.chat;
            renderChatV2(workspace);
        }
    };

    setCaseChatState = function(
        active,
        workspace = activeWorkspaceV2
    ) {
        if (!workspace) return;
        workspace.chatRunning = active;
        if (isActiveV2(workspace)) {
            syncGlobalsV2(workspace);
            renderChatV2(workspace);
            updateControlsV2();
        }
        refreshTasksV2(workspace);
    };

    sendCaseQuestion = async function() {
        const workspace = activeWorkspaceV2;
        if (!workspace) {
            alert("请先选择患者");
            return;
        }
        if (workspace.chatRunning) return;

        const input =
            document.getElementById("case-chat-input");
        const question = input.value.trim();
        if (!question) return;

        workspace.chatDraft = "";
        input.value = "";

        const visitId = await ensureVisitV2(workspace);
        if (!visitId) return;

        if (isActiveV2(workspace)) {
            try {
                workspace.record = collectTemplateSections();
            } catch (_) {}
        }

        const recordSnapshot = JSON.parse(
            JSON.stringify(workspace.record || emptyRecord())
        );
        const conversationSnapshot =
            workspace.conversation.map(item => ({...item}));
        const previousHistory = workspace.chatHistory
            .filter(item =>
                item.role === "user" ||
                item.role === "assistant"
            )
            .slice(-8);

        workspace.chatHistory.push({
            role: "user",
            content: question
        });
        workspace.status.chat =
            "正在调用本机模型；可切换患者，回答会保留在本患者中";

        const task = makeTaskV2(
            workspace,
            "病例问答",
            `病例问答：${question.slice(0, 28)}${question.length > 28 ? "…" : ""}`
        );
        setCaseChatState(true, workspace);

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
                    history: previousHistory
                })
            });

            let data = {};
            try { data = await response.json(); } catch (_) {}

            if (!response.ok || !data.answer) {
                throw new Error(
                    data.detail ||
                    `问答失败（HTTP ${response.status}）`
                );
            }

            workspace.chatHistory.push({
                role: "assistant",
                content: data.answer
            });
            workspace.chatHistory =
                workspace.chatHistory.slice(-20);
            workspace.status.chat =
                `回答来自本机模型 ${data.local_model || ""}，请医生审核`;
            completeTaskV2(workspace, task, "问答完成");
            workspaceLogV2(
                workspace,
                "完成一次本地病例问答"
            );
        } catch (error) {
            workspace.chatHistory.push({
                role: "assistant",
                content:
                    "问答失败：" +
                    error.message +
                    "\n请确认右上角显示“LLM就绪”。"
            });
            workspace.status.chat = "问答失败";
            failTaskV2(workspace, task, error.message);
            workspaceLogV2(
                workspace,
                "病例问答失败：" + error.message
            );
        } finally {
            setCaseChatState(false, workspace);
            if (isActiveV2(workspace)) {
                document.getElementById("case-chat-status").textContent =
                    workspace.status.chat;
                document.getElementById("case-chat-input").focus();
            }
        }
    };

    log = function(message) {
        workspaceLogV2(activeWorkspaceV2, message);
    };

    // Keep per-patient selections and drafts current.
    const originalSetSpeakerV2 = setSpeaker;
    setSpeaker = function(speaker) {
        originalSetSpeakerV2(speaker);
        if (activeWorkspaceV2) {
            activeWorkspaceV2.currentSpeaker = speaker;
        }
    };

    document.getElementById("upload-speaker")
        ?.addEventListener("change", event => {
            if (activeWorkspaceV2) {
                activeWorkspaceV2.uploadSpeaker = event.target.value;
            }
        });

    document.getElementById("text-import-speaker")
        ?.addEventListener("change", event => {
            if (activeWorkspaceV2) {
                activeWorkspaceV2.textSpeaker = event.target.value;
            }
        });

    document.getElementById("transcript-text-input")
        ?.addEventListener("input", event => {
            if (activeWorkspaceV2) {
                activeWorkspaceV2.textDraft = event.target.value;
            }
        });

    document.getElementById("case-chat-input")
        ?.addEventListener("input", event => {
            if (activeWorkspaceV2) {
                activeWorkspaceV2.chatDraft = event.target.value;
            }
        });

    refreshGlobalTaskBadgeV2();
    updateControlsV2();

    // Workspace API used by optional local feature modules.
    window.dentalMultiPatientV2 = {
        version: "2.1",
        getWorkspaceCount: () => patientWorkspacesV2.size,
        getActiveTaskCount: () =>
            [...patientWorkspacesV2.values()]
                .reduce(
                    (sum, workspace) =>
                        sum + activeTasksV2(workspace).length,
                    0
                ),
        getActiveWorkspace: () => activeWorkspaceV2,
        isActiveWorkspace: isActiveV2,
        ensureVisit: ensureVisitV2,
        syncGlobals: syncGlobalsV2,
        renderWorkspace: renderWorkspaceV2,
        renderChat: renderChatV2,
        renderInfo: renderInfoV2,
        renderLogs: renderLogsV2,
        renderTasks: renderWorkspaceTaskStatusV2,
        renderConversation: renderConversationList,
        updateControls: updateControlsV2,
        addConversation: addConversationV2,
        generateTextRecord: generateForV2,
        makeTask: makeTaskV2,
        updateTask: updateTaskV2,
        completeTask: completeTaskV2,
        failTask: failTaskV2,
        refreshTasks: refreshTasksV2,
        workspaceLog: workspaceLogV2,
        escapeHtml
    };
})();
