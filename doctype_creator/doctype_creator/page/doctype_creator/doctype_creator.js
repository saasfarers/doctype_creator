frappe.pages['doctype-creator'].on_page_load = function(wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'DocType Creator Dashboard',
        single_column: true
    });

    wrapper.sheet_data = {};
    wrapper.sheet_mappings = {};
    wrapper.frappe_modules = ['Custom']; // Fallback

    // NEW: Fetch all Frappe Modules in the background as soon as the page loads
    frappe.call({
        method: 'doctype_creator.api.get_active_modules',
        callback: function(r) {
            if(r.message) {
                wrapper.frappe_modules = r.message;
            }
        }
    });

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

    if (!wrapper.sheet_data || Object.keys(wrapper.sheet_data).length === 0) {
        container.html(`<div class="alert alert-danger mt-4">Upload Failed: The backend could not read any sheets.</div>`);
        return;
    }

    let sheet_names = Object.keys(wrapper.sheet_data);
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
                                <div><input type="checkbox" class="sheet-checkbox mr-2" value="${name}"><strong>${name}</strong></div>
                                <span class="badge badge-warning sheet-status" id="badge-${safe_id(name)}">Pending</span>
                            </li>
                        `).join('')}
                    </ul>
                    <div class="card-footer">
                        <div class="checkbox mb-2">
                            <label><input type="checkbox" id="auto-create-dt"> <b>Auto-Create Missing DocTypes</b></label>
                        </div>
                        <div id="module-wrapper" style="display: none; margin-bottom: 15px;">
                            <label style="font-size: 12px; color: #555;">Select Target Module</label>
                            <select id="target-module" class="form-control form-control-sm">
                                ${wrapper.frappe_modules.map(m => `<option value="${m}" ${m === 'Custom' ? 'selected' : ''}>${m}</option>`).join('')}
                            </select>
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

    // Toggle Module Input visibility when checkbox is clicked
    container.find('#auto-create-dt').on('change', function() {
        if($(this).is(':checked')) {
            container.find('#module-wrapper').slideDown(200);
        } else {
            container.find('#module-wrapper').slideUp(200);
        }
    });

    container.find('.sheet-item').on('click', function(e) {
        if(e.target.type === "checkbox") return; 
        container.find('.sheet-item').removeClass('bg-light border-primary');
        $(this).addClass('bg-light border-primary');
        render_mapper_workspace($(this).data('sheet'), wrapper, container);
    });

    container.find('#process-batch-btn').on('click', () => {
        let selected_sheets = [];
        container.find('.sheet-checkbox:checked').each(function() { selected_sheets.push($(this).val()); });

        if(selected_sheets.length === 0) {
            frappe.msgprint("Please select at least one sheet using the checkboxes.");
            return;
        }

        let batch_mappings = {};
        let missing_confirmations = [];

        selected_sheets.forEach(sheet => {
            if(wrapper.sheet_mappings[sheet]) batch_mappings[sheet] = wrapper.sheet_mappings[sheet];
            else missing_confirmations.push(sheet);
        });

        if(missing_confirmations.length > 0) {
            frappe.msgprint(`Unconfirmed sheets selected: <b>${missing_confirmations.join(', ')}</b>. Confirm them first.`);
            return;
        }

        // GRAB THE MODULE VALUE
        let auto_create = container.find('#auto-create-dt').is(':checked') ? 1 : 0;
        let target_module = container.find('#target-module').val() || "Custom";
        
        execute_batch_injection(wrapper.file_url, batch_mappings, auto_create, target_module);
    });

    // Import/Export Logic
    container.find('#export-btn').on('click', () => {
        let dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(wrapper.sheet_mappings));
        let a = document.createElement('a'); a.href = dataStr; a.download = "mapping_profile.json"; a.click();
    });

    container.find('#import-btn').on('click', () => {
        let input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
        input.onchange = e => {
            let reader = new FileReader(); reader.readAsText(e.target.files[0], 'UTF-8');
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
                <thead>
                    <tr class="bg-light">
                        <th style="width: 50%;">Excel Column (Source)</th>
                        <th style="width: 50%;">Frappe Property (Target)</th>
                    </tr>
                </thead>
                <tbody id="mapping-body">`;

    const frappe_props = [
        { id: "target_doctype", label: "Target DocType (Required)" },
        { id: "label", label: "Field Label" },
        { id: "fieldname", label: "Field Name (slug) (Required)" },
        { id: "fieldtype", label: "Field Type" },
        { id: "options", label: "Options (For Link/Select)" },
        { id: "reqd", label: "Mandatory (Yes/No)" },
        { id: "default", label: "Default Value" },
        { id: "description", label: "Description" },
        { id: "hidden", label: "Hidden (Yes/No)" },
        { id: "read_only", label: "Read Only (Yes/No)" },
        { id: "depends_on", label: "Depends On (Logic)" },
        { id: "in_list_view", label: "In List View (Yes/No)" }
    ];

    headers.forEach(header => {
        let options = `<option value="">-- Ignore / Do Not Map --</option>`;

        frappe_props.forEach(prop => {
            // Check if this property was previously saved to this specific header
            let is_saved_match = saved_mapping[prop.id] === header;

            // Smart auto-guess if no saved mapping exists yet
            let is_auto_match = !saved_mapping[prop.id] && (header.toLowerCase().includes(prop.id.split('_')[0]) || prop.label.toLowerCase().includes(header.toLowerCase()));

            let selected = (is_saved_match || is_auto_match) ? 'selected' : '';
            options += `<option value="${prop.id}" ${selected}>${prop.label}</option>`;
        });

        html += `<tr class="mapping-row" data-header="${header}">
                    <td><strong>${header}</strong></td>
                    <td><select class="form-control prop-select">${options}</select></td>
                 </tr>`;
    });

    html += `</tbody></table>
             <div class="mt-3 text-right">
                <button id="confirm-sheet-btn" class="btn btn-success">Save & Confirm Configuration</button>
             </div>`;
    
    ws.html(html);

    ws.find('#confirm-sheet-btn').on('click', () => {
        let mapping = {};
        let assigned_props = [];
        let duplicate_error = false;

        ws.find('.mapping-row').each(function() {
            let excel_col = $(this).data('header');
            let selected_prop = $(this).find('.prop-select').val();

            if(selected_prop) {
                // BUG PREVENTION: Check if we already mapped this Frappe Property
                if(assigned_props.includes(selected_prop)) {
                    let prop_label = frappe_props.find(p => p.id === selected_prop).label;
                    frappe.msgprint(`<b>Duplicate Mapping Error:</b> You have mapped "<b>${prop_label}</b>" to multiple columns. Each target property can only be used once per sheet.`);
                    duplicate_error = true;
                    return false; // This breaks out of the jQuery .each() loop
                }
                
                assigned_props.push(selected_prop);
                mapping[selected_prop] = excel_col;
            }
        });

        // Stop execution if duplicates were found
        if(duplicate_error) return;

        // Check for mandatory fields
        if(!mapping['target_doctype'] || !mapping['fieldname']) {
            frappe.msgprint("<b>Target DocType</b> and <b>Field Name</b> mappings are strictly required before saving.");
            return;
        }

        // Save to global state
        wrapper.sheet_mappings[sheet_name] = mapping;
        
        let safe_id = sheet_name.replace(/[^a-zA-Z0-9]/g, '_');
        
        // Visual updates
        frappe.show_alert({message: `${sheet_name} mapping saved!`, indicator: 'green'});
        main_container.find(`#badge-${safe_id}`).removeClass('badge-warning').addClass('badge-success').text('Confirmed ✅');
        main_container.find(`.sheet-checkbox[value="${sheet_name}"]`).prop('checked', true); 
    });
}

function execute_batch_injection(file_url, batch_mappings, auto_create, target_module) {
    frappe.call({
        method: 'doctype_creator.api.process_batch_injection',
        args: { 
            file_url: file_url,
            batch_mappings: batch_mappings,
            auto_create: auto_create,
            target_module: target_module 
        },
        freeze: true,
        freeze_message: "Injecting Database Fields... (This may take a minute)",
        callback: function(r) {
            let res = r.message;
            
            if (res && res.excel_base64) {
                // Instantly trigger Excel download
                download_excel_report(res.excel_base64);
                
                let failed_count = res.errors ? res.errors.length : 0;
                let success_count = res.fields_injected;

                if (failed_count > 0) {
                    frappe.msgprint({ 
                        title: "Injection Completed with some Errors", 
                        message: `Successfully injected <b>${success_count}</b> fields, but hit <b>${failed_count}</b> errors.<br><br><b>A detailed Excel report (.xlsx) has been downloaded automatically.</b> Check it to see exactly which fields failed and their Field Types.`, 
                        indicator: 'orange' 
                    });
                } else {
                    frappe.show_alert({message: `Massive Success! Injected ${success_count} fields cleanly. Excel report downloaded.`, indicator: 'green'});
                }
            } else {
                frappe.msgprint("Something went wrong processing the response.");
            }
        }
    });
}

function download_excel_report(base64_data) {
    // Decode Base64 string to Binary Array
    const byteCharacters = atob(base64_data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    
    // Create a Blob with the official Excel MIME type
    const blob = new Blob([byteArray], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    
    // Trigger download
    let url = URL.createObjectURL(blob);
    let link = document.createElement("a");
    link.href = url;
    link.download = "DocType_Injection_Report.xlsx";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}