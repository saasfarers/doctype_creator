import frappe
import json
import pandas as pd

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
def process_batch_injection(file_url: str, batch_mappings: str, auto_create: int = 0) -> dict:
    """Processes multiple sheets in one go based on their confirmed mappings."""
    if isinstance(batch_mappings, str):
        batch_mappings = json.loads(batch_mappings) # Format: {"Sheet1": {mapping}, "Sheet2": {mapping}}

    file_doc = frappe.get_doc("File", {"file_url": file_url})
    file_path = file_doc.get_full_path()

    mapped_data = []
    errors = []

    # Read each configured sheet
    for sheet_name, column_mapping in batch_mappings.items():
        try:
            if file_path.endswith('.csv'):
                df = pd.read_csv(file_path) # CSV ignores sheet_name
            else:
                df = pd.read_excel(file_path, sheet_name=sheet_name)
                
            for _, row in df.iterrows():
                field_dict = {}
                for frappe_prop, excel_col in column_mapping.items():
                    val = row.get(excel_col)
                    if pd.isna(val): val = ""
                    field_dict[frappe_prop] = val
                mapped_data.append(field_dict)
                
        except Exception as e:
            errors.append({"sheet": sheet_name, "error": f"Failed to read sheet: {str(e)}"})
            continue

    # Group all collected data by target doctype
    success_count = 0
    doctype_groups = {}

    for row in mapped_data:
        dt = str(row.get("target_doctype")).strip()
        if not dt or dt == "nan" or dt == "": continue
        if dt not in doctype_groups: doctype_groups[dt] = []
        doctype_groups[dt].append(row)

    # Inject grouped fields
    for doctype_name, fields_to_add in doctype_groups.items():
        try:
            if not frappe.db.exists("DocType", doctype_name):
                if int(auto_create) == 1:
                    new_dt = frappe.get_doc({
                        "doctype": "DocType", "name": doctype_name,
                        "module": "Custom", "custom": 1, "fields": []
                    })
                    new_dt.insert(ignore_permissions=True)
                else:
                    errors.append({"doctype": doctype_name, "error": "DocType does not exist. Enable Auto-Create."})
                    continue
                
            doc = frappe.get_doc("DocType", doctype_name)
            existing_fieldnames = [f.fieldname for f in doc.fields]
            fields_added = False

            for field in fields_to_add:
                fname = str(field.get("fieldname")).strip()
                if not fname or fname == "nan": continue
                if fname in existing_fieldnames:
                    errors.append({"doctype": doctype_name, "field": fname, "error": "Field already exists."})
                    continue

                raw_type = str(field.get("fieldtype", "Data"))
                actual_type = raw_type.split(" ")[0] if "Link" in raw_type else raw_type
                options = raw_type.split("(")[1].replace(")", "") if "Link" in raw_type and "(" in raw_type else ""

                reqd_val = field.get("reqd", 0)
                is_reqd = 1 if str(reqd_val).lower() in ['yes', '1', 'true'] else 0

                doc.append("fields", {
                    "fieldname": fname, "label": str(field.get("label")),
                    "fieldtype": actual_type, "options": options,
                    "reqd": is_reqd, "description": str(field.get("description", ""))
                })
                fields_added = True
                success_count += 1
                
            if fields_added:
                doc.save(ignore_permissions=True)
                
        except Exception as e:
            errors.append({"doctype": doctype_name, "error": str(e)})

    return {"status": "success", "fields_injected": success_count, "errors": errors}