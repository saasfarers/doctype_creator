frappe.pages['doctype-creator'].on_page_load = function(wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'DocType Creator Dashboard',
        single_column: true
    });

    // Global state for the session
    wrapper.sheet_data = {};     // Holds all headers { "Sheet1": [cols], ... }
    wrapper.sheet_mappings = {}; // Holds confirmed mappings { "Sheet1": {map}, ... }

    page.set_primary_action('Upload Excel/CSV', () => {
        new frappe.ui.FileUploader({
            folder: 'Home',
            on_success: (file_doc) => {
                wrapper.file_url = file_doc.file_url;
                process_uploaded_file(file_doc.file_url, wrapper);
            }
        });
    });

    $(wrapper).find('.layout-main-section').append(`
        <div id="creator-container" class="mt-4">
            <div class="text-center text-muted p-5 border rounded" style="background: #f8f9fa;">
                <h4>No File Uploaded</h4>
                <p>Please upload a CSV or Excel file to start configuring your schemas.</p>
            </div>
        </div>
    `);
}

function process_uploaded_file(file_url, wrapper) {
    frappe.call({
        method: 'doctype_creator.api.get_file_headers',
        args: { file_url: file_url },
        freeze: true,
        freeze_message: "Reading Sheets...",
        callback: function(r) {
            if (r.message && r.message.status === 'success') {
                wrapper.sheet_data = r.message.data;
                render_dashboard(wrapper);
            } else {
                frappe.msgprint("Error reading file.");
            }
        }
    });
}

function render_dashboard(wrapper) {
    let container = $(wrapper).find('#creator-container');
    container.empty();

    // SAFETY CHECK: Did we actually get data?
    if (!wrapper.sheet_data || Object.keys(wrapper.sheet_data).length === 0) {
        container.html(`
            <div class="alert alert-danger mt-4">
                <strong>Upload Failed:</strong> The backend could not read any sheets from this file. 
                Please ensure it is a valid CSV or Excel file.
            </div>
        `);
        return;
    }

    let sheet_names = Object.keys(wrapper.sheet_data);
    
    // SAFE ID GENERATOR: Replaces spaces and special chars with underscores
    let safe_id = (name) => name.replace(/[^a-zA-Z0-9]/g, '_');
    
    let html = `
        <div class="row mt-4">
            <div class="col-md-4">
                <div class="card">
                    <div class="card-header bg-light">
                        <h5 class="mb-0">Detected Sheets</h5>
                    </div>
                    <ul class="list-group list-group-flush" id="sheet-list">
                        ${sheet_names.map(name => `
                            <li class="list-group-item d-flex justify-content-between align-items-center sheet-item" style="cursor:pointer;" data-sheet="${name}">
                                <div>
                                    <input type="checkbox" class="sheet-checkbox mr-2" value="${name}">
                                    <strong>${name}</strong>
                                </div>
                                <span class="badge badge-warning sheet-status" id="badge-${safe_id(name)}">Pending</span>
                            </li>
                        `).join('')}
                    </ul>
                    <div class="card-footer">
                        <div class="checkbox mb-2">
                            <label><input type="checkbox" id="auto-create-dt"> Auto-Create Missing DocTypes</label>
                        </div>
                        <button id="process-batch-btn" class="btn btn-primary btn-block">Inject Selected Sheets</button>
                    </div>
                </div>
            </div>

            <div class="col-md-8">
                <div class="card">
                    <div class="card-header bg-light d-flex justify-content-between align-items-center">
                        <h5 class="mb-0" id="active-sheet-title">Select a sheet to map</h5>
                        <div>
                            <button class="btn btn-sm btn-default mr-1" id="import-btn">Import JSON</button>
                            <button class="btn btn-sm btn-default" id="export-btn">Export JSON</button>
                        </div>
                    </div>
                    <div class="card-body" id="mapping-workspace">
                        <p class="text-muted">Click a sheet on the left to configure its field mappings.</p>
                    </div>
                </div>
            </div>
        </div>
    `;
    container.html(html);

    // Sidebar Clicks
    container.find('.sheet-item').on('click', function(e) {
        if(e.target.type === "checkbox") return; 
        
        container.find('.sheet-item').removeClass('bg-light border-primary');
        $(this).addClass('bg-light border-primary');
        
        let sheet_name = $(this).data('sheet');
        render_mapper_workspace(sheet_name, wrapper, container);
    });

    // Batch Process
    container.find('#process-batch-btn').on('click', () => {
        let selected_sheets = [];
        container.find('.sheet-checkbox:checked').each(function() {
            selected_sheets.push($(this).val());
        });

        if(selected_sheets.length === 0) {
            frappe.msgprint("Please select at least one sheet using the checkboxes.");
            return;
        }

        let batch_mappings = {};
        let missing_confirmations = [];

        selected_sheets.forEach(sheet => {
            if(wrapper.sheet_mappings[sheet]) {
                batch_mappings[sheet] = wrapper.sheet_mappings[sheet];
            } else {
                missing_confirmations.push(sheet);
            }
        });

        if(missing_confirmations.length > 0) {
            frappe.msgprint(`You selected sheets that haven't been mapped and confirmed yet: <b>${missing_confirmations.join(', ')}</b>. Please confirm them first.`);
            return;
        }

        let auto_create = container.find('#auto-create-dt').is(':checked') ? 1 : 0;
        execute_batch_injection(wrapper.file_url, batch_mappings, auto_create);
    });

    // Export/Import JSON
    container.find('#export-btn').on('click', () => {
        let dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(wrapper.sheet_mappings));
        let a = document.createElement('a'); a.href = dataStr; a.download = "mapping_profile.json"; a.click();
    });

    container.find('#import-btn').on('click', () => {
        let input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
        input.onchange = e => {
            let reader = new FileReader();
            reader.readAsText(e.target.files[0], 'UTF-8');
            reader.onload = re => {
                wrapper.sheet_mappings = JSON.parse(re.target.result);
                Object.keys(wrapper.sheet_mappings).forEach(s => {
                    container.find(`#badge-${safe_id(s)}`).removeClass('badge-warning').addClass('badge-success').text('Confirmed ✅');
                    container.find(`.sheet-checkbox[value="${s}"]`).prop('checked', true);
                });
                frappe.show_alert({message: 'Mappings Loaded!', indicator: 'green'});
            }
        }
        input.click();
    });
}

function render_mapper_workspace(sheet_name, wrapper, main_container) {
    main_container.find('#active-sheet-title').text(`Mapping: ${sheet_name}`);
    let ws = main_container.find('#mapping-workspace');
    ws.empty();

    let headers = wrapper.sheet_data[sheet_name];
    let saved_mapping = wrapper.sheet_mappings[sheet_name] || {};

    let html = `<table class="table table-bordered">
                <thead><tr class="bg-light"><th>Frappe Property</th><th>Excel Column</th></tr></thead>
                <tbody id="mapping-body">`;

    const required_props = [
        { id: "target_doctype", label: "Target DocType" },
        { id: "label", label: "Field Label" },
        { id: "fieldname", label: "Field Name (slug)" },
        { id: "fieldtype", label: "Field Type" },
        { id: "reqd", label: "Mandatory (Yes/No)" },
        { id: "description", label: "Description" }
    ];

    required_props.forEach(prop => {
        let options = `<option value="">-- Ignore / Set Manually --</option>`;
        headers.forEach(header => {
            let is_match = saved_mapping[prop.id] === header || (!saved_mapping[prop.id] && (header.toLowerCase().includes(prop.id.split('_')[0]) || prop.label.toLowerCase().includes(header.toLowerCase())));
            options += `<option value="${header}" ${is_match ? 'selected' : ''}>${header}</option>`;
        });

        html += `<tr class="mapping-row" data-prop="${prop.id}">
                    <td><strong>${prop.label}</strong></td>
                    <td><select class="form-control column-select">${options}</select></td>
                 </tr>`;
    });

    html += `</tbody></table>
             <div class="mt-3 text-right">
                <button id="confirm-sheet-btn" class="btn btn-success">Save & Confirm Configuration</button>
             </div>`;
    
    ws.html(html);

    ws.find('#confirm-sheet-btn').on('click', () => {
        let mapping = {};
        ws.find('.mapping-row').each(function() {
            let val = $(this).find('.column-select').val();
            if(val) mapping[$(this).data('prop')] = val;
        });

        if(!mapping['target_doctype'] || !mapping['fieldname']) {
            frappe.msgprint("Target DocType and Field Name mappings are required before saving.");
            return;
        }

        // Save to global state
        wrapper.sheet_mappings[sheet_name] = mapping;
        
        // Visual updates
        frappe.show_alert({message: `${sheet_name} mapping saved!`, indicator: 'green'});
        let valid_id = frappe.utils.make_valid_name(sheet_name);
        main_container.find(`#badge-${valid_id}`).removeClass('badge-warning').addClass('badge-success').text('Confirmed ✅');
        main_container.find(`.sheet-checkbox[value="${sheet_name}"]`).prop('checked', true); // Auto-check it for processing
    });
}

function execute_batch_injection(file_url, batch_mappings, auto_create) {
    frappe.call({
        method: 'doctype_creator.api.process_batch_injection',
        args: { 
            file_url: file_url,
            batch_mappings: batch_mappings,
            auto_create: auto_create
        },
        freeze: true,
        freeze_message: "Processing Batch Injection...",
        callback: function(r) {
            let res = r.message;
            if (res && res.errors && res.errors.length > 0) {
                console.error("Batch Errors:", res.errors);
                frappe.msgprint({title: "Batch Completed with Errors", message: `Successfully injected ${res.fields_injected} fields, but encountered ${res.errors.length} errors. Please check the browser console for exact details.`});
            } else if (res && res.status === 'success') {
                frappe.show_alert({message: `Massive Success! Injected ${res.fields_injected} fields across all selected sheets.`, indicator: 'green'});
            }
        }
    });
}