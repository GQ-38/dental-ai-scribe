(() => {
    const workspaceApi = window.dentalMultiPatientV2;
    const multimodalApi = window.dentalMultimodalV21;

    if (!workspaceApi || !multimodalApi) {
        console.error("v2.2 clinical UI dependencies are unavailable.");
        return;
    }

    let sectionUploadTarget = "待归类";

    function activeWorkspace() {
        return workspaceApi.getActiveWorkspace();
    }

    function escapeHtmlValue(value) {
        return workspaceApi.escapeHtml(String(value ?? ""));
    }

    // ========================================================
    // Patient extra fields
    // ========================================================
    function normalizeExtraFields(fields) {
        return (Array.isArray(fields) ? fields : [])
            .map(item => ({
                label: String(item?.label || "").trim(),
                value: String(item?.value || "").trim()
            }))
            .filter(item => item.label || item.value)
            .map(item => ({
                label: item.label || "补充信息",
                value: item.value
            }))
            .slice(0, 30);
    }

    function extraContainer(mode) {
        return document.getElementById(
            mode === "new"
                ? "new-patient-extra-fields"
                : "edit-patient-extra-fields"
        );
    }

    function extraRowHtml(mode, item = {}) {
        const rowId =
            `${mode}-extra-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return `
            <div id="${rowId}" class="patient-extra-edit-row">
                <input type="text"
                    data-extra-label
                    value="${escapeHtmlValue(item.label || "")}"
                    placeholder="项目，如职业"
                    class="px-2 py-2 border rounded-lg text-sm">
                <input type="text"
                    data-extra-value
                    value="${escapeHtmlValue(item.value || "")}"
                    placeholder="描述内容"
                    class="px-2 py-2 border rounded-lg text-sm">
                <button type="button"
                    onclick="removePatientExtraField('${rowId}')"
                    class="rounded-lg border border-red-100 text-red-400 hover:bg-red-50">
                    ×
                </button>
            </div>
        `;
    }

    window.addPatientExtraField = (mode, item = {}) => {
        const container = extraContainer(mode);
        if (!container) return;
        if (container.children.length >= 30) {
            alert("补充信息最多添加 30 行");
            return;
        }
        container.insertAdjacentHTML("beforeend", extraRowHtml(mode, item));
    };

    window.removePatientExtraField = rowId => {
        document.getElementById(rowId)?.remove();
    };

    function setExtraFields(mode, fields) {
        const container = extraContainer(mode);
        if (!container) return;
        container.innerHTML = "";
        normalizeExtraFields(fields).forEach(item =>
            window.addPatientExtraField(mode, item)
        );
    }

    function collectExtraFields(mode) {
        const container = extraContainer(mode);
        if (!container) return [];

        return [...container.querySelectorAll(".patient-extra-edit-row")]
            .map(row => ({
                label:
                    row.querySelector("[data-extra-label]")?.value.trim() || "",
                value:
                    row.querySelector("[data-extra-value]")?.value.trim() || ""
            }))
            .filter(item => item.label || item.value)
            .map(item => ({
                label: item.label || "补充信息",
                value: item.value
            }));
    }

    window.renderCurrentPatient = function() {
        if (!currentPatient) return;

        document.getElementById("p-name").textContent =
            currentPatient.name || "--";
        document.getElementById("p-gender").textContent =
            currentPatient.gender || "--";
        document.getElementById("p-age").textContent =
            currentPatient.age !== null &&
            currentPatient.age !== undefined
                ? currentPatient.age
                : "--";
        document.getElementById("p-phone").textContent =
            currentPatient.phone || "--";
        document.getElementById("p-allergy").textContent =
            currentPatient.allergy || "否认";

        const container =
            document.getElementById("patient-extra-fields");
        const fields = normalizeExtraFields(currentPatient.extra_fields);

        if (!fields.length) {
            container.innerHTML = "";
            container.classList.add("hidden");
            return;
        }

        container.classList.remove("hidden");
        container.innerHTML = fields.map(item => `
            <div class="patient-extra-row">
                <span class="patient-extra-label">${escapeHtmlValue(item.label)}：</span>
                <span class="break-words min-w-0">${escapeHtmlValue(item.value || "未填写")}</span>
            </div>
        `).join("");
    };

    window.showNewPatientModal = function() {
        [
            "new-name",
            "new-age",
            "new-phone",
            "new-allergy"
        ].forEach(id => {
            const input = document.getElementById(id);
            if (input) input.value = "";
        });
        document.getElementById("new-gender").value = "";
        setExtraFields("new", []);
        document.getElementById("new-patient-modal")
            .classList.remove("hidden");
        document.getElementById("new-name")?.focus();
    };

    window.createPatient = async function() {
        const ageRaw =
            document.getElementById("new-age").value.trim();
        const body = {
            name: document.getElementById("new-name").value.trim(),
            gender: document.getElementById("new-gender").value,
            age: ageRaw === "" ? null : Number(ageRaw),
            phone: document.getElementById("new-phone").value.trim(),
            allergy:
                document.getElementById("new-allergy").value.trim() ||
                "否认",
            extra_fields: collectExtraFields("new")
        };

        if (!body.name) {
            alert("请输入姓名");
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

        try {
            const response = await fetch(`${API_BASE}/api/patients`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(body)
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(
                    data.detail || `创建失败（HTTP ${response.status}）`
                );
            }

            patientCache.set(Number(data.id), data);
            closeNewPatientModal();
            await selectPatient(
                data.id,
                data.name,
                data.gender,
                data.age,
                data.phone,
                data.allergy
            );

            const workspace = activeWorkspace();
            if (workspace) {
                workspace.patient = data;
                currentPatient = data;
                workspaceApi.renderWorkspace(workspace);
            }
            workspaceApi.workspaceLog(
                workspace,
                `新建患者：${data.name}`
            );
        } catch (error) {
            alert("创建失败：" + error.message);
        }
    };

    window.showEditPatientModal = function() {
        if (!currentPatient) {
            alert("请先选择患者");
            return;
        }

        document.getElementById("edit-name").value =
            currentPatient.name || "";
        document.getElementById("edit-gender").value =
            currentPatient.gender || "";
        document.getElementById("edit-age").value =
            currentPatient.age !== null &&
            currentPatient.age !== undefined
                ? currentPatient.age
                : "";
        document.getElementById("edit-phone").value =
            currentPatient.phone || "";
        document.getElementById("edit-allergy").value =
            currentPatient.allergy || "否认";
        setExtraFields("edit", currentPatient.extra_fields || []);

        document.getElementById("edit-patient-modal")
            .classList.remove("hidden");
    };

    window.updatePatient = async function() {
        const workspace = activeWorkspace();
        if (!workspace?.patient) return;

        const ageRaw =
            document.getElementById("edit-age").value.trim();
        const body = {
            name: document.getElementById("edit-name").value.trim(),
            gender: document.getElementById("edit-gender").value,
            age: ageRaw === "" ? null : Number(ageRaw),
            phone: document.getElementById("edit-phone").value.trim(),
            allergy:
                document.getElementById("edit-allergy").value.trim() ||
                "否认",
            extra_fields: collectExtraFields("edit")
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

        const button =
            document.getElementById("btn-update-patient");
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
            const data = await response.json();
            if (!response.ok) {
                throw new Error(
                    data.detail || `保存失败（HTTP ${response.status}）`
                );
            }

            workspace.patient = data;
            currentPatient = data;
            patientCache.set(Number(data.id), data);
            window.renderCurrentPatient();
            closeEditPatientModal();
            workspaceApi.workspaceLog(
                workspace,
                `已修改患者信息：${data.name}`
            );
            appendCaseSystemMessage(
                "患者基本信息已更新，后续问答将使用最新资料。",
                workspace
            );
        } catch (error) {
            alert("修改患者信息失败：" + error.message);
            workspaceApi.workspaceLog(
                workspace,
                "修改患者信息失败：" + error.message
            );
        } finally {
            button.disabled = false;
            button.textContent = "保存修改";
        }
    };

    window.deleteCurrentPatient = async function() {
        const workspace = activeWorkspace();
        const patient = workspace?.patient || currentPatient;
        if (!patient) {
            alert("请先选择患者");
            return;
        }

        const firstConfirm = confirm(
            `删除“${patient.name}”会永久删除其就诊记录、病历和病例图片。\n\n确定继续吗？`
        );
        if (!firstConfirm) return;

        const typed = prompt(
            `为防止误删，请输入患者姓名：${patient.name}`
        );
        if (typed !== patient.name) {
            alert("姓名不匹配，已取消删除");
            return;
        }

        try {
            const response = await fetch(
                `${API_BASE}/api/patients/${patient.id}`,
                {method: "DELETE"}
            );
            const data = await response.json();
            if (!response.ok) {
                throw new Error(
                    data.detail || `删除失败（HTTP ${response.status}）`
                );
            }

            alert(`患者“${patient.name}”已删除`);
            window.location.reload();
        } catch (error) {
            alert("删除患者失败：" + error.message);
        }
    };

    // Preserve the complete patient object, including custom fields.
    window.selectPatientFromCache = async function(patientId) {
        const patient = patientCache.get(Number(patientId));
        if (!patient) {
            alert("患者信息已变化，请重新打开患者列表");
            return;
        }

        await selectPatient(
            patient.id,
            patient.name,
            patient.gender,
            patient.age,
            patient.phone,
            patient.allergy
        );

        const workspace = activeWorkspace();
        if (workspace) {
            workspace.patient = {...workspace.patient, ...patient};
            currentPatient = workspace.patient;
            workspaceApi.renderWorkspace(workspace);
        }
    };

    // ========================================================
    // Per-section image upload and paste
    // ========================================================
    function sectionCard(section) {
        return document.getElementById(`template-section-${section}`);
    }

    function sectionActionsHtml(section) {
        const encoded = escapeHtmlValue(section);
        return `
            <div class="section-media-actions" data-section-media="${encoded}">
                <button type="button"
                    class="section-media-button"
                    onclick="selectSectionImages('${encoded}')">
                    上传图片
                </button>
                <button type="button"
                    class="section-media-button"
                    onclick="pasteSectionImage('${encoded}')">
                    粘贴图片
                </button>
            </div>
        `;
    }

    function decorateSectionImageActions() {
        CLINICAL_SECTIONS.forEach(section => {
            const card = sectionCard(section);
            const header =
                card?.querySelector(".template-section-header");
            if (!header) return;
            if (header.querySelector("[data-section-media]")) return;

            const existingActionGroup =
                header.querySelector(".flex.items-center.gap-2");
            if (existingActionGroup) {
                existingActionGroup.insertAdjacentHTML(
                    "beforeend",
                    sectionActionsHtml(section)
                );
            } else {
                header.insertAdjacentHTML(
                    "beforeend",
                    sectionActionsHtml(section)
                );
            }
        });
    }

    const previousRenderRecordEditor = window.renderRecordEditor;
    window.renderRecordEditor = function(record = {}) {
        previousRenderRecordEditor(record);
        decorateSectionImageActions();
    };

    window.selectSectionImages = section => {
        if (!activeWorkspace()) {
            alert("请先选择患者");
            return;
        }
        sectionUploadTarget = section;
        const input = document.getElementById("section-image-input");
        input.value = "";
        input.click();
    };

    window.handleSectionImageSelect = async event => {
        const files = [...(event.target.files || [])];
        event.target.value = "";
        if (!files.length) return;

        const workspace = activeWorkspace();
        if (!workspace) {
            alert("请先选择患者");
            return;
        }

        await multimodalApi.uploadCaseImageFiles(
            files,
            workspace,
            {section: sectionUploadTarget}
        );
        multimodalApi.refreshImageUi(workspace);
        decorateSectionImageActions();
    };

    async function clipboardImageFiles() {
        if (!navigator.clipboard?.read) {
            throw new Error(
                "浏览器未授权直接读取图片，请使用“上传图片”或在左侧描述框按 Ctrl+V"
            );
        }

        const clipboardItems = await navigator.clipboard.read();
        const files = [];

        for (const item of clipboardItems) {
            for (const type of item.types) {
                if (!type.startsWith("image/")) continue;
                const blob = await item.getType(type);
                const extension =
                    type === "image/png"
                        ? "png"
                        : type === "image/webp"
                            ? "webp"
                            : "jpg";
                files.push(
                    new File(
                        [blob],
                        `section-paste-${Date.now()}-${files.length + 1}.${extension}`,
                        {type}
                    )
                );
            }
        }
        return files;
    }

    window.pasteSectionImage = async section => {
        const workspace = activeWorkspace();
        if (!workspace) {
            alert("请先选择患者");
            return;
        }

        try {
            const files = await clipboardImageFiles();
            if (!files.length) {
                throw new Error("剪贴板中没有图片");
            }

            await multimodalApi.uploadCaseImageFiles(
                files,
                workspace,
                {section}
            );
            multimodalApi.refreshImageUi(workspace);
            decorateSectionImageActions();
        } catch (error) {
            alert(error.message);
        }
    };

    // Ensure the buttons stay visible after workspace switching and AI rerender.
    const originalWorkspaceRendered =
        multimodalApi.onWorkspaceRendered;
    multimodalApi.onWorkspaceRendered = function(workspace) {
        originalWorkspaceRendered?.(workspace);
        setTimeout(decorateSectionImageActions, 0);
    };

    setTimeout(() => {
        decorateSectionImageActions();
        const workspace = activeWorkspace();
        if (workspace) window.renderCurrentPatient();
    }, 0);

    window.dentalClinicalUiV22 = {
        version: "2.3",
        decorateSectionImageActions,
        normalizeExtraFields
    };
})();
