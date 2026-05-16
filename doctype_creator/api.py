import frappe
import json
import pandas as pd
import io
import base64

@frappe.whitelist()
def get_file_headers(file_url: str) -> dict:
    file_doc = frappe.get_doc("File", {"file_url": file_url})
    file_path = file_doc.get_full_path()
    
    result = {}
    try:
        # Convert path to lower case just for checking the extension safely
        check_path = file_path.lower()
        
        if check_path.endswith('.csv'):
            df = pd.read_csv(file_path, nrows=0)
            result['CSV Data'] = list(df.columns)
        elif check_path.endswith(('.xls', '.xlsx')):
            xls = pd.ExcelFile(file_path)
            for sheet_name in xls.sheet_names:
                df = pd.read_excel(xls, sheet_name=sheet_name, nrows=0)
                result[sheet_name] = list(df.columns)
                
        return {"status": "success", "data": result}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@frappe.whitelist()
def process_batch_injection(file_url: str, batch_mappings: str, auto_create: int = 0, target_module: str = "Custom") -> dict:
    if isinstance(batch_mappings, str):
        batch_mappings = json.loads(batch_mappings)

    file_doc = frappe.get_doc("File", {"file_url": file_url})
    file_path = file_doc.get_full_path()

    mapped_data = []
    report_data = [] 

    # Read Data
    for sheet_name, column_mapping in batch_mappings.items():
        try:
            if file_path.endswith('.csv'):
                df = pd.read_csv(file_path)
            else:
                df = pd.read_excel(file_path, sheet_name=sheet_name)
                
            for _, row in df.iterrows():
                field_dict = {}
                for frappe_prop, excel_col in column_mapping.items():
                    val = row.get(excel_col)
                    if pd.isna(val): val = ""
                    field_dict[frappe_prop] = val
                field_dict["_sheet"] = sheet_name 
                mapped_data.append(field_dict)
                
        except Exception as e:
            report_data.append({"Sheet": sheet_name, "Target DocType": "-", "Field Label": "-", "Field Name": "-", "Field Type": "-", "Status": "Failed", "Error Details": f"Failed to read sheet: {str(e)}"})
            continue

    success_count = 0
    doctype_groups = {}

    for row in mapped_data:
        dt = str(row.get("target_doctype")).strip()
        if not dt or dt == "nan" or dt == "": continue
        if dt not in doctype_groups: doctype_groups[dt] = []
        doctype_groups[dt].append(row)

    # Process and Inject
    for doctype_name, fields_to_add in doctype_groups.items():
        if not frappe.db.exists("DocType", doctype_name):
            if int(auto_create) == 1:
                try:
                    selected_module = target_module if target_module else "Custom"
                    is_custom_doctype = 1 if selected_module == "Custom" else 0
                    new_dt = frappe.get_doc({
                        "doctype": "DocType", "name": doctype_name,
                        "module": selected_module, "custom": is_custom_doctype, "fields": []
                    })
                    new_dt.insert(ignore_permissions=True)
                except Exception as e:
                    for field in fields_to_add:
                        report_data.append({"Sheet": field.get("_sheet", ""), "Target DocType": doctype_name, "Field Label": field.get("label", ""), "Field Name": field.get("fieldname", ""), "Field Type": field.get("fieldtype", "-"), "Status": "Failed", "Error Details": f"Failed to create DocType: {str(e)}"})
                    continue
            else:
                for field in fields_to_add:
                    report_data.append({"Sheet": field.get("_sheet", ""), "Target DocType": doctype_name, "Field Label": field.get("label", ""), "Field Name": field.get("fieldname", ""), "Field Type": field.get("fieldtype", "-"), "Status": "Failed", "Error Details": "DocType does not exist. Enable Auto-Create."})
                continue

        for field in fields_to_add:
            fname = str(field.get("fieldname")).strip()
            f_label = str(field.get("label", fname))
            sheet_src = field.get("_sheet", "")
            
            raw_type = str(field.get("fieldtype", "Data"))
            actual_type = raw_type.split(" ")[0] if "Link" in raw_type else raw_type

            # New Report Row Structure with Field Type included
            report_row = {"Sheet": sheet_src, "Target DocType": doctype_name, "Field Label": f_label, "Field Name": fname, "Field Type": actual_type, "Status": "", "Error Details": ""}

            if not fname or fname == "nan": 
                continue

            doc = frappe.get_doc("DocType", doctype_name)
            existing_fieldnames = [f.fieldname for f in doc.fields]

            if fname in existing_fieldnames:
                report_row["Status"] = "Failed"
                report_row["Error Details"] = "Field already exists."
                report_data.append(report_row)
                continue
            
            if fname.lower() == "name":
                report_row["Status"] = "Failed"
                report_row["Error Details"] = "Restricted: Cannot use 'name' as a custom field name."
                report_data.append(report_row)
                continue

            extracted_options = raw_type.split("(")[1].replace(")", "") if "Link" in raw_type and "(" in raw_type else ""
            final_options = str(field.get("options", "")) if "options" in field and not pd.isna(field.get("options")) else extracted_options

            field_data = {
                "fieldname": fname, "label": f_label,
                "fieldtype": actual_type, "options": final_options,
                "reqd": 1 if str(field.get("reqd", "")).lower() in ['yes', '1', 'true'] else 0
            }

            for prop in ["description", "default", "depends_on"]:
                if prop in field and not pd.isna(field[prop]): field_data[prop] = str(field[prop])

            for prop in ["hidden", "read_only", "in_list_view"]:
                if prop in field and not pd.isna(field[prop]): field_data[prop] = 1 if str(field[prop]).lower() in ['yes', '1', 'true'] else 0

            doc.append("fields", field_data)
            
            try:
                doc.save(ignore_permissions=True)
                report_row["Status"] = "Success"
                success_count += 1
            except Exception as e:
                report_row["Status"] = "Failed"
                report_row["Error Details"] = str(e).split('\n')[0] 
            
            report_data.append(report_row)

    # GENERATE EXCEL FILE IN MEMORY
    if not report_data:
        report_data.append({"Sheet": "-", "Target DocType": "-", "Field Label": "-", "Field Name": "-", "Field Type": "-", "Status": "Info", "Error Details": "No valid data to process."})

    df_report = pd.DataFrame(report_data)
    excel_buffer = io.BytesIO()
    
    # Write to BytesIO buffer
    with pd.ExcelWriter(excel_buffer, engine='openpyxl') as writer:
        df_report.to_excel(writer, index=False, sheet_name='Injection Report')
    
    # Encode binary Excel file to Base64
    excel_base64 = base64.b64encode(excel_buffer.getvalue()).decode('utf-8')
    failed_rows = [r for r in report_data if r["Status"] == "Failed"]

    return {
        "status": "success", 
        "fields_injected": success_count, 
        "errors": failed_rows,
        "excel_base64": excel_base64
    }


@frappe.whitelist()
def get_active_modules():
    """Fetches all existing modules to populate the dropdown."""
    return frappe.get_all("Module Def", pluck="name", order_by="name asc")